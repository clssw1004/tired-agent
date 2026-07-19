/**
 * ChatTimelineView — mobile-first chat timeline for structured mode.
 *
 * Renders a list of StructuredContent items as a chat timeline:
 * - User messages → right-aligned bubble
 * - Assistant text → left-aligned prose
 * - Tool calls → collapsible cards (default collapsed on mobile)
 * - Code blocks → horizontal scroll + copy button
 * - Stream events → animated typing indicator
 * - Usage badges → compact metadata
 *
 * Mobile-first: all components work at 360px width with readable fonts.
 * Desktop gets slightly larger text but the same layout.
 *
 * ## Auto-scroll behaviour
 *
 * When new content arrives and the user is near the bottom (≤30px threshold),
 * the container auto-scrolls to show the latest content. If the user has
 * scrolled up to read history, a "↓ Jump to bottom" pill appears.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StructuredContent } from '@tired-agent/protocol';

interface Props {
  contents: StructuredContent[];
  /** True if the stream is still receiving data (show typing indicator). */
  streaming?: boolean;
}

const SCROLL_THRESHOLD_PX = 30;
const ENCODER = new TextEncoder();

export function ChatTimelineView({ contents, streaming }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [copyFlash, setCopyFlash] = useState<string | null>(null);

  // ── Auto-scroll when new content arrives ─────────────────────────────
  useEffect(() => {
    if (!atBottom || !containerRef.current) return;
    // Use requestAnimationFrame to let React finish rendering first.
    requestAnimationFrame(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    });
  }, [contents, atBottom]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(dist <= SCROLL_THRESHOLD_PX);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, []);

  // ── Copy code to clipboard ───────────────────────────────────────────
  const copyCode = useCallback(async (code: string, id: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyFlash(id);
      try { navigator.vibrate?.(10); } catch { /* iOS no-op */ }
      setTimeout(() => setCopyFlash(prev => prev === id ? null : prev), 900);
    } catch { /* ignore */ }
  }, []);

  // ── Check if there are streaming items ───────────────────────────────
  const hasStreamEvents = contents.some(c => c.type === 'streamEvent');

  return (
    <div className="chat-timeline-container">
      <div
        ref={containerRef}
        className="chat-timeline"
        onScroll={handleScroll}
      >
        {contents.map((c, i) => (
          <TimelineItem
            key={i}
            content={c}
            expandedTool={expandedTool}
            onToggleTool={(id) => setExpandedTool(prev => prev === id ? null : id)}
            copyFlash={copyFlash}
            onCopyCode={copyCode}
          />
        ))}

        {/* Streaming indicator when in streaming state but no streamEvent items */}
        {streaming && !hasStreamEvents && contents.length > 0 && (
          <div className="streaming-indicator">
            <span className="streaming-dot" />
            <span className="streaming-dot" />
            <span className="streaming-dot" />
          </div>
        )}

        {/* Bottom spacer for safe area */}
        <div className="chat-timeline-bottom-spacer" />
      </div>

      {/* "Jump to bottom" pill — shown when user scrolls up */}
      {!atBottom && (
        <button
          type="button"
          className="jump-to-bottom"
          onClick={scrollToBottom}
          aria-label="Jump to latest"
        >
          ↓ 最新
        </button>
      )}
    </div>
  );
}

// ── Single timeline item ───────────────────────────────────────────────

interface TimelineItemProps {
  content: StructuredContent;
  expandedTool: string | null;
  onToggleTool: (id: string) => void;
  copyFlash: string | null;
  onCopyCode: (code: string, id: string) => void;
}

function TimelineItem({ content, expandedTool, onToggleTool, copyFlash, onCopyCode }: TimelineItemProps) {
  switch (content.type) {
    case 'userMessage':
      return <UserBubble text={content.text} />;

    case 'text':
      return <AssistantBubble text={content.text} />;

    case 'code':
      return (
        <CodeBlock
          code={content.code}
          language={content.language}
          id={`code-${content.code.slice(0, 20)}`}
          copyFlash={copyFlash}
          onCopy={onCopyCode}
        />
      );

    case 'toolUse':
      return (
        <ToolUseCard
          name={content.name}
          input={content.input}
          toolUseId={content.toolUseId}
          completed={!!content.completed}
          isExpanded={expandedTool === content.toolUseId}
          onToggle={() => onToggleTool(content.toolUseId)}
        />
      );

    case 'toolResult':
      return (
        <ToolResultCard
          content={content.content}
          isError={!!content.isError}
        />
      );

    case 'streamEvent':
      // "思考中…" comes from thinking blocks — show animated indicator.
      if (content.text === '思考中…' || content.text.includes('思考')) {
        return <ThinkingIndicator text={content.text} />;
      }
      return <StreamingText text={content.text} />;

    case 'status':
      return <StatusIndicator status={content.status} text={content.text} />;

    case 'usage':
      return <UsageBadge input={content.inputTokens} output={content.outputTokens} />;

    case 'divider':
      return (
        <div className="timeline-divider">
          {content.label && <span className="timeline-divider-label">{content.label}</span>}
        </div>
      );

    default:
      return null;
  }
}

// ── Sub-components ─────────────────────────────────────────────────────

/** User message — right-aligned bubble. */
function UserBubble({ text }: { text: string }) {
  return (
    <div className="user-bubble">
      <p className="user-bubble-text">{text}</p>
    </div>
  );
}

/** Assistant text — left-aligned prose. */
function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="assistant-bubble">
      <p className="assistant-bubble-text">{text}</p>
    </div>
  );
}

/** Code block — horizontal scroll + copy button. */
function CodeBlock({
  code,
  language,
  id,
  copyFlash,
  onCopy,
}: {
  code: string;
  language?: string;
  id: string;
  copyFlash: string | null;
  onCopy: (code: string, id: string) => void;
}) {
  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-lang">{language ?? 'code'}</span>
        <button
          type="button"
          className={'code-block-copy' + (copyFlash === id ? ' is-flash' : '')}
          onClick={() => onCopy(code, id)}
          aria-label="Copy code"
        >
          {copyFlash === id ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="code-block">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Tool call — collapsible card. Default collapsed on mobile. */
function ToolUseCard({
  name,
  input,
  toolUseId,
  completed,
  isExpanded,
  onToggle,
}: {
  name: string;
  input: string;
  toolUseId: string;
  completed: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const statusIcon = completed ? '✔' : '⏳';
  const statusClass = completed ? 'done' : 'pending';

  return (
    <div className={'tool-use-card' + (completed ? ' is-completed' : '')}>
      <button
        type="button"
        className="tool-use-card-header"
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <span className="tool-use-icon">{isExpanded ? '▼' : '▶'}</span>
        <span className={'tool-use-status-icon ' + statusClass}>{statusIcon}</span>
        <span className="tool-use-name">{name}</span>
      </button>

      {isExpanded && (
        <div className="tool-use-card-body">
          <div className="tool-use-section-label">参数</div>
          <pre className="tool-use-json">{input}</pre>
        </div>
      )}
    </div>
  );
}

/** Tool result — content with error styling. */
function ToolResultCard({ content, isError }: { content: string; isError: boolean }) {
  if (!content) return null;

  return (
    <div className={'tool-result-card' + (isError ? ' is-error' : '')}>
      <pre className="tool-result-content">{content}</pre>
    </div>
  );
}

/** Streaming text — pulsing animation for in-flight content. */
function StreamingText({ text }: { text: string }) {
  return (
    <div className="streaming-text">
      <span className="streaming-text-content">{text}</span>
      <span className="streaming-cursor">▊</span>
    </div>
  );
}

/** Thinking indicator — animated dots. */
function ThinkingIndicator({ text }: { text?: string }) {
  return (
    <div className="thinking-indicator">
      <span className="thinking-text">{text || '思考中'}</span>
      <span className="thinking-dots">
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </span>
    </div>
  );
}

/** Status indicator — thinking, working, done, error. */
function StatusIndicator({ status, text }: { status: string; text: string }) {
  const icon = status === 'thinking' ? '' : status === 'error' ? '✕' : status === 'done' ? '✔' : '●';
  return (
    <div className={'status-indicator status-' + status}>
      {status === 'thinking' ? (
        <ThinkingIndicator text={text} />
      ) : (
        <>
          <span className="status-icon">{icon}</span>
          <span className="status-text">{text}</span>
        </>
      )}
    </div>
  );
}

/** Usage badge — token counts. */
function UsageBadge({ input, output }: { input: number; output: number }) {
  const fmt = (n: number): string => {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  };

  return (
    <div className="usage-badge">
      ↑ {fmt(input)} / ↓ {fmt(output)}
    </div>
  );
}
