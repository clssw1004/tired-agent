/**
 * PtySessionViewMobile — mobile-specific shell for a PTY session.
 *
 * Layout (top to bottom):
 *   1. Header         — title + status dot (no ⌨ 控制条 toggle on mobile).
 *   2. Status strip   — live / typing / connecting / error / offline.
 *   3. RenderArea     — TerminalView (xterm.js) + copy-FAB + jump-to-bottom.
 *   4. Output-tail banner (when truncated).
 *   5. InterventionBar + PtyMobileKeyboard (custom on-screen keys).
 *
 * Difference from desktop: no PtyInputBar (mobile cannot summon a system
 * keyboard from an xterm canvas), no SpecialKeysBar toggle (the mobile
 * keyboard already exposes Esc / Ctrl / arrows). The custom keyboard
 * lives in PtyMobileKeyboard.
 *
 * Future mobile-specific polish (collapsed header, merged status, etc.)
 * will be added here — keeping that work isolated from the desktop shell.
 */

import { useState } from 'react';
import type { PtySessionViewSharedProps } from './shared';
import { formatBytes } from './shared';
import { TerminalView } from '../render-views';
import { ChatTimeline } from '../ChatTimeline';
import { PtyInterventionBar } from '../PtyInterventionBar';
import { PtyMobileKeyboard } from '../PtyMobileKeyboard';

export function PtySessionViewMobile(p: PtySessionViewSharedProps) {
  const {
    serverRef, sessionLabel, onBack, mode, sessionStatus,
    connected, transportError, typing, atBottom, outputTail,
    tailBannerDismissed, dismissTailBanner, structuredContents, streaming,
    selection, copyFlash, termRef, modifiers,
    writeBytes, copySelection, handleTermResize, loadFullHistory,
    setAtBottom, setModifier, consumeModifier,
  } = p;

  const status: 'typing' | 'live' | 'connecting' | 'error' | 'offline' =
    transportError ? 'error'
    : !connected ? 'connecting'
    : typing ? 'typing'
    : sessionStatus === 'exited' ? 'offline'
    : 'live';

  const disabled = sessionStatus === 'exited';

  /** Mobile-only: toggle to hide the header and reclaim ~36px for the
   *  terminal. The toggle button is rendered as a sibling of the header
   *  with position: fixed so it stays reachable when the header is hidden. */
  const [headerHidden, setHeaderHidden] = useState(false);

  const STATUS_LABEL: Record<typeof status, string> = {
    typing: 'typing…',
    live: 'live',
    connecting: 'connecting…',
    error: 'disconnected: ' + (transportError || 'unknown'),
    offline: 'session has exited',
  };

  return (
    <>
      <header className={'chat-header' + (headerHidden ? ' is-hidden' : '')}>
        {onBack && (
          <button type="button" className="chat-back" onClick={onBack} aria-label="Back">‹</button>
        )}
        <div className="chat-titles">
          <span className="chat-title-name">{sessionLabel || '…'}</span>
        </div>
        <span
          className={'chat-status-merged chat-status-merged-' + status}
          aria-label={'status: ' + STATUS_LABEL[status]}
        >
          {STATUS_LABEL[status]}
        </span>
        <span className={'chat-status-dot dot-' + sessionStatus} aria-hidden />
      </header>
      <button
        type="button"
        className="chat-fullscreen-toggle"
        onClick={() => setHeaderHidden((v) => !v)}
        aria-label={headerHidden ? 'Show header' : 'Hide header'}
        aria-pressed={headerHidden}
        title={headerHidden ? '显示菜单栏' : '隐藏菜单栏'}
      >
        {headerHidden ? '⌄' : '⌃'}
      </button>

      <div
        className={'render-area' + (mode === 'persistent' ? ' render-area-structured' : '')}
        onClick={() => {
          // Mobile intentionally does NOT focus xterm's hidden textarea.
          // On touch devices that focus summons the system IME and buries
          // our on-screen PtyMobileKeyboard. Bytes are piped to the PTY
          // through sendInput regardless of focus state, so the terminal
          // doesn't need to be the active element to receive input.
          // Persistent (chat) mode mounts ChatTimeline — no xterm, no-op.
          void mode;
        }}
      >
        {mode === 'persistent' ? (
          <ChatTimeline contents={structuredContents} streaming={streaming} />
        ) : (
          <>
            <TerminalView
              ref={termRef}
              onUserInput={(data) => void writeBytes(data)}
              onSelectionChange={() => {/* host tracks selection */}}
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
        key={mode === 'persistent' ? 'persistent' : 'ready'}
        terminal={mode === 'persistent' ? null : termRef.current}
        onResponse={(text) => void writeBytes(text)}
      />

      <div className="pty-input-wrapper">
        <PtyMobileKeyboard
          disabled={disabled}
          modifiers={modifiers}
          onSetModifier={setModifier}
          onConsumeModifier={consumeModifier}
          onKey={(bytes) => void writeBytes(bytes)}
        />
      </div>
    </>
  );
}
