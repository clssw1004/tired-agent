/**
 * Shared types, constants, and utilities for PtySessionView (entry) +
 * PtySessionViewDesktop / PtySessionViewMobile. Lifting these out keeps the
 * three components thin and prevents prop-drift between desktop / mobile.
 */

import type { RefObject } from 'react';
import type {
  ServerRef,
  SessionStatus,
  SessionMode,
  StructuredContent,
} from '@tired-agent/protocol';
import type { TerminalHandle } from '../render-views';
import type {
  ModifierKey,
  ModifierMode,
  ModifierState,
} from '../SpecialKeysBar';

// ── Tuning constants ──────────────────────────────────────────────────────

/** Typing indicator window — anything newer than this counts as "typing". */
export const TYPING_TIMEOUT_MS = 500;

/** Heartbeat interval for force-rendering the typing indicator. */
export const TICK_INTERVAL_MS = 250;

/** Debounce window for pushing PTY cols/rows back to the backend. */
export const RESIZE_DEBOUNCE_MS = 200;

/** Safety valve for RAF output batching when frames are starved. */
export const OUTPUT_FLUSH_TIMEOUT_MS = 50;

/** Fast-load only the last N bytes of the session log on first open. */
export const PTY_OUTPUT_TAIL_BYTES = 64 * 1024;

/** Auto-dismiss the truncation banner after this many ms. */
export const TAIL_BANNER_DISMISS_MS = 3000;

/** Modifier keys start inactive. */
export const INITIAL_MODIFIER_STATE: ModifierState = { ctrl: 'off', shift: 'off' };

// ── Types ─────────────────────────────────────────────────────────────────

export interface OutputTailState {
  truncated: boolean;
  totalBytes: number;
  loadedBytes: number;
}

/** Props that PtySessionView passes to both Desktop and Mobile shells. */
export interface PtySessionViewSharedProps {
  // Server / session identification
  serverRef: ServerRef;
  agentId: string;
  sessionId: string;
  sessionLabel: string;
  sessionCmd: string;
  sessionArgs: string[];
  sessionStatus: SessionStatus | string;
  sessionMode?: SessionMode;
  onBack?: () => void;

  // Live state
  connected: boolean;
  transportError: string | null;
  termReady: boolean;
  typing: boolean;
  atBottom: boolean;
  busy: boolean;
  outputTail: OutputTailState | null;
  tailBannerDismissed: boolean;
  mode: SessionMode;
  structuredContents: StructuredContent[];
  streaming: boolean;
  modifiers: ModifierState;
  selection: string;
  copyFlash: boolean;
  termRef: RefObject<TerminalHandle>;

  // Callbacks
  writeBytes: (data: string) => Promise<void>;
  handleTermResize: (cols: number, rows: number) => void;
  copySelection: () => Promise<void>;
  loadFullHistory: () => Promise<void>;
  dismissTailBanner: () => void;
  setModifier: (key: ModifierKey, mode: ModifierMode) => void;
  consumeModifier: (key: ModifierKey) => void;
  setAtBottom: (v: boolean) => void;
}

// ── Utilities ─────────────────────────────────────────────────────────────

/** Pretty-print a byte count for the truncation banner. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Decode base64 to Uint8Array. React Native (and older browsers) lack
 *  atob/btoa on binary strings, but Uint8Array + globalThis.atob is
 *  available everywhere we target. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
