/**
 * Session domain types — server-internal, not exposed on the wire
 * (wire-level types live in @tired-agent/protocol).
 */

import type {
  SessionStatus,
  SessionMode,
  SessionSpec,
} from '@tired-agent/protocol';

export interface SessionRecord {
  id: string;
  cmd: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string> | null;
  status: SessionStatus;
  pid: number | null;
  exitCode: number | null;
  createdAt: number;
  exitedAt: number | null;
  byteOffset: number;
  cols: number;
  rows: number;
  label: string | null;
  mode: SessionMode | null;
  /**
   * Persistent (chat) mode only: Claude's internal session_id extracted from
   * the NDJSON stream. Persisted so `--resume` survives an agent restart.
   */
  claudeSessionId: string | null;
}

/** Build a SessionRecord from a creation spec + generated id. */
export function createSessionRecord(
  id: string,
  spec: SessionSpec,
): SessionRecord {
  return {
    id,
    cmd: spec.cmd,
    args: spec.args ?? [],
    cwd: spec.cwd ?? null,
    env: spec.env ?? null,
    status: 'starting',
    pid: null,
    exitCode: null,
    createdAt: Date.now(),
    exitedAt: null,
    byteOffset: 0,
    cols: spec.cols ?? 80,
    rows: spec.rows ?? 24,
    label: spec.label ?? null,
    mode: spec.mode ?? null,
    claudeSessionId: null,
  };
}
