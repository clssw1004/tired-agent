/**
 * PtySessionViewDesktop — desktop-specific shell for a PTY session.
 *
 * Layout (top to bottom):
 *   1. Header         — title + status dot + ⌨ 控制条 toggle (desktop-only).
 *   2. Status strip   — live / typing / connecting / error / offline.
 *   3. RenderArea     — TerminalView (xterm.js) + copy-FAB + jump-to-bottom.
 *   4. Output-tail banner (when truncated).
 *   5. InterventionBar + optional SpecialKeysBar + PtyInputBar (system kb).
 *
 * Why split from PtySessionView:
 *   Desktop gets a separate input bar (PtyInputBar — system keyboard
 *   passthrough via a real <input>) and an optional Ctrl/C/Esc/Arrow
 *   keyboard toggle (SpecialKeysBar). Mobile (PtySessionViewMobile)
 *   uses PtyMobileKeyboard instead and never shows the toggle.
 *
 * State: only `showControls` lives here; everything else is lifted to
 * PtySessionView and passed via {@link PtySessionViewSharedProps}.
 */

import { useState } from 'react';
import type { PtySessionViewSharedProps } from './shared';
import { formatBytes } from './shared';
import { TerminalView } from '../render-views';
import { ChatTimeline } from '../ChatTimeline';
import { PtyInterventionBar } from '../PtyInterventionBar';
import { PtyInputBar } from '../PtyInputBar';
import { SpecialKeysBar } from '../SpecialKeysBar';

export function PtySessionViewDesktop(p: PtySessionViewSharedProps) {
  const {
    serverRef, sessionLabel, onBack, mode, sessionStatus,
    connected, transportError, termReady, typing, atBottom, busy, outputTail,
    tailBannerDismissed, dismissTailBanner, structuredContents, streaming,
    selection, copyFlash, termRef, modifiers,
    writeBytes, copySelection, handleTermResize, loadFullHistory,
    setAtBottom, setModifier, consumeModifier,
  } = p;

  /** Desktop-only: when true, render SpecialKeysBar so the user can
   *  press Esc / Ctrl+C / arrows without clicking the xterm canvas. */
  const [showControls, setShowControls] = useState(false);

  const status: 'typing' | 'live' | 'connecting' | 'error' | 'offline' =
    transportError ? 'error'
    : !connected ? 'connecting'
    : typing ? 'typing'
    : sessionStatus === 'exited' ? 'offline'
    : 'live';

  const disabled = sessionStatus === 'exited';

  return (
    <>
      <header className="chat-header">
        {onBack && (
          <button type="button" className="chat-back" onClick={onBack} aria-label="Back">‹</button>
        )}
        <span className="chat-avatar chat-avatar-pc" aria-hidden>PC</span>
        <div className="chat-titles">
          <span className="chat-title-name">{sessionLabel || '…'}</span>
          <span className="chat-title-host">{serverRef.name} · {serverRef.baseUrl}</span>
        </div>
        {mode === 'process' && (
          <button
            type="button"
            className={'chat-toggle-controls' + (showControls ? ' is-on' : '')}
            onClick={() => setShowControls((v) => !v)}
            aria-pressed={showControls}
            aria-label="Toggle terminal controls"
            title={showControls ? '隐藏控制条' : '显示控制条（Esc / Ctrl+C / 方向键…）'}
          >
            {showControls ? '⌨ 隐藏控制条' : '⌨ 控制条'}
          </button>
        )}
        <span className={'chat-status-dot dot-' + sessionStatus} aria-label={'session ' + sessionStatus} />
      </header>

      <div className={'chat-status chat-status-' + status} role="status">
        <span className="chat-status-bar" />
        <span className="chat-status-text">
          {status === 'typing' && 'typing…'}
          {status === 'live' && 'live'}
          {status === 'connecting' && 'connecting…'}
          {status === 'error' && 'disconnected: ' + transportError}
          {status === 'offline' && 'session has exited'}
        </span>
      </div>

      <div
        className={'render-area' + (mode === 'persistent' ? ' render-area-structured' : '')}
        onClick={() => mode !== 'persistent' && termRef.current?.focus()}
      >
        {mode === 'persistent' ? (
          <ChatTimeline contents={structuredContents} streaming={streaming} />
        ) : (
          <>
            <TerminalView
              ref={termRef}
              onReady={() => {/* host already tracks termReady */}}
              onUserInput={(data) => void writeBytes(data)}
              onSelectionChange={() => {/* host already tracks selection */}}
              onScroll={(ab) => setAtBottom(ab)}
              onResize={handleTermResize}
            />
            {selection && (
              <button
                type="button"
                className={'xterm-copy-fab' + (copyFlash ? ' is-flash' : '')}
                onClick={(e) => { e.stopPropagation(); void copySelection(); }}
                aria-label="Copy selection"
              >
                <span aria-hidden>📋</span>
                <span>{copyFlash ? '已复制' : '复制'}</span>
              </button>
            )}
            {!atBottom && (
              <button
                type="button"
                className="jump-to-bottom"
                onClick={(e) => {
                  e.stopPropagation();
                  termRef.current?.scrollToBottom();
                  setAtBottom(true);
                }}
                aria-label="Jump to latest output"
              >
                ↓ 跳到最新
              </button>
            )}
          </>
        )}
      </div>

      {outputTail?.truncated && !tailBannerDismissed && (
        <div className="output-truncated-banner" role="status">
          <span>
            已加载尾部 {formatBytes(outputTail.loadedBytes)} / 共 {formatBytes(outputTail.totalBytes)}
          </span>
          <button type="button" onClick={() => void loadFullHistory()}>
            加载完整历史
          </button>
          <button
            type="button"
            className="banner-dismiss"
            onClick={dismissTailBanner}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
      )}

      <PtyInterventionBar
        key={mode === 'persistent' ? 'persistent' : termReady ? 'ready' : 'pending'}
        terminal={mode === 'persistent' ? null : termReady ? termRef.current : null}
        onResponse={(text) => void writeBytes(text)}
      />

      {mode === 'persistent' ? (
        <>
          <SpecialKeysBar
            disabled={disabled}
            structured={true}
            modifiers={modifiers}
            onSetModifier={setModifier}
            onConsumeModifier={consumeModifier}
            onKey={(bytes) => void writeBytes(bytes)}
          />
          <PtyInputBar
            disabled={disabled}
            sending={false}
            sessionId={p.sessionId}
            placeholder={disabled ? '会话已结束' : busy ? 'Claude 处理中…' : '输入消息…'}
            onChange={(data) => void writeBytes(data)}
            modifiers={modifiers}
            onConsumeModifier={consumeModifier}
          />
        </>
      ) : (
        <div className="pty-input-wrapper">
          {showControls && (
            <SpecialKeysBar
              disabled={disabled}
              structured={false}
              modifiers={modifiers}
              onSetModifier={setModifier}
              onConsumeModifier={consumeModifier}
              onKey={(bytes) => void writeBytes(bytes)}
              forceVisible={true}
            />
          )}
          <PtyInputBar
            disabled={disabled}
            sending={false}
            sessionId={p.sessionId}
            placeholder={disabled ? '会话已结束' : busy ? 'Claude 处理中…' : '输入框 — 手机键盘直通'}
            onChange={(data) => void writeBytes(data)}
            modifiers={modifiers}
            onConsumeModifier={consumeModifier}
          />
        </div>
      )}
    </>
  );
}
