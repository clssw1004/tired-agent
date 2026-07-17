/**
 * Claude CLI Renderer.
 *
 * Claude renders into a TUI on a single 80-col PTY and emits a lot of cursor
 * positioning + spinner redraws. This renderer:
 *
 *   1. Strips OSC / DCS / cursor-positioning CSI, keeps SGR colour
 *   2. Splits the stream by cursor moves (best-effort fallback) into a
 *      virtual layout: top "header" divider region, conversation region
 *      ("●" lines = answers), and a footer status region.
 *   3. Spinner / progress frames (\r overwrite) collapse to the last frame.
 *   4. Emits a normal chat bubble of ContentText for the assistant's reply,
 *      plus ContentStatus chips for short-lived spinners (displayMode
 *      'replace-last' so they don't pile up).
 *
 * Heuristics used to detect Claude output (used by detector):
 *   - cmd name contains "claude" (Claude Code CLI)
 *   - output contains "⏺" or "●" markers used for assistant messages
 *   - output contains ESC[?2026h (DEC private sync begin)
 */

import type { ContentStatus, ContentText, StructuredContent } from '@tired-pc/protocol';
import type {
  AgentRenderer,
  RenderContext,
  RenderOutput,
} from '../types.js';

const ESC_BYTE = String.fromCharCode(0x1B);
const BEL_BYTE = String.fromCharCode(0x07);

// Same pre-processing as generic-pty: drop OSC/DCS/mode-toggles, drop
// cursor-CSI, keep SGR + text. Then collapse \r overwrite.
const ANSI_OSC_RE = new RegExp(
  ESC_BYTE + '\\][^' + BEL_BYTE + ']*(?:' + BEL_BYTE + '|' + ESC_BYTE + '\\\\)',
  'g',
);
const ANSI_DCS_RE = new RegExp(
  ESC_BYTE + '[PX^][^' + BEL_BYTE + ']*(?:' + BEL_BYTE + '|' + ESC_BYTE + '\\\\)',
  'g',
);
const ANSI_ESC_SHORT_RE = new RegExp(ESC_BYTE + '[\\x40-\\x5A\\\\\\-_]', 'g');
// Match ONLY cursor-move / erase CSIs — non-'m' finals. Non-SGR also means
// we drop them; we don't try to honour positioning (chat UI has no grid).
const CSI_NON_SGR_RE = new RegExp(ESC_BYTE + '\\[\\??[\\d;]*[A-HJKSTfgluhl]', 'g');

const SPINNER_FRAMES = ['⠂', '⠐', '⠈', '⠘', '⠸', '⠰', '⠠', '⠄'];
const SPINNER_LINE_RE = new RegExp(
  '^([\\s╭╮╰╯│─┌┐└┘├┤┬┴┼╞╡╪╫╬]*)([⠂⠐⠈⠘⠸⠰⠠⠄✳✻✽✶✢·*])( .+)$',
);

function dropSpinners(line: string): { clean: string; spinner?: string } {
  const m = line.match(SPINNER_LINE_RE);
  if (!m) return { clean: line };
  return { clean: '', spinner: m[2] + (m[3] ?? '').trim() };
}

function extractSgrColor(sgrParams: string): { color?: string; bold?: boolean } {
  if (!sgrParams) return {};
  const parts = sgrParams.split(';').map(Number);
  let color: string | undefined;
  let bold: boolean | undefined;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 1) bold = true;
    if (p === 38 && parts[i + 1] === 5) {
      const n = parts[i + 2];
      // Minimal subset — full palette mapping can come later.
      color = '#cd3131';      // red-ish
      if (n === 174) color = '#fab387'; // claude orange
      if (n === 244) color = '#6c6c80'; // dim grey
      if (n === 246) color = '#888';
      i += 2;
    }
  }
  return { color, bold };
}

export class ClaudeRenderer implements AgentRenderer {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  private buffer = '';
  private lastLines: string[] = [];
  // The "open" spinner text (if any) — gets replaced in-place by useReplace.
  private openSpinner: string | null = null;
  // The most recent assistant reply (everything since the last `\n●`).
  private assistant: string[] = [];
  // Assistant bubble open?
  private inAssistant = false;

  processChunk(chunk: string, _ctx: RenderContext): RenderOutput {
    this.buffer += chunk;
    return this.drain(/*force*/ false);
  }

  flush(): RenderOutput {
    return this.drain(/*force*/ true);
  }

  reset(): void {
    this.buffer = '';
    this.lastLines = [];
    this.openSpinner = null;
    this.assistant = [];
    this.inAssistant = false;
  }

  /** Drain pending buffered text, run the line-based state machine,
   *  return a RenderOutput reflecting whatever changed since the last call. */
  private drain(force: boolean): RenderOutput {
    // Pre-process: strip non-rendering escape sequences, collapse \r overwrites.
    let text = this.buffer
      .replace(ANSI_OSC_RE, '')
      .replace(ANSI_DCS_RE, '')
      .replace(ANSI_ESC_SHORT_RE, '')
      .replace(CSI_NON_SGR_RE, '')
      // Normalise spinner-overwrite lines.
      .replace(/\r(?!\n)/g, '\n')
      .replace(/\r\n/g, '\n');
    // Keep the partial trailing line so the spinner can be emitted before
    // its line terminator arrives — but only when forcing a flush.
    const lastNL = text.lastIndexOf('\n');
    if (lastNL < 0) {
      if (!force) return { contents: [], displayMode: 'chat' };
      // fall through with full buffer when force=true
    } else if (!force) {
      text = text.slice(0, lastNL + 1);
    }

    const lines = text.split('\n');
    if (this.buffer && !force) {
      // Re-keep the trailing partial line in this.buffer for next round.
      this.buffer = this.buffer.slice(0, this.buffer.length - (lines[lines.length - 1] ?? '').length - 1);
    }

    // We emit few, opinionated chunks per drain:
    //   - a fresh "●" line → assistant toggle (new contentText block)
    //   - a spinner-frames line → ContentStatus with ephemeral
    //   - everything else → append to current assistant
    const newContents: StructuredContent[] = [];
    let replacedStatus = false;

    for (const rawLine of lines) {
      const line = stripSgr(rawLine).trim();
      if (!line) continue;
      // Spin lines: emit status with ephemeral → replaced in-place each frame.
      const spin = isSpinnerLine(line);
      if (spin) {
        if (this.openSpinner !== spin) {
          const st: ContentStatus = {
            type: 'status',
            status: 'working',
            text: spin,
            ephemeral: true,
          };
          newContents.push(st);
          this.openSpinner = spin;
          replacedStatus = true;
        }
        continue;
      }

      // Bubble-level signals.
      const isAnswer = /^[●○]\s/.test(line);
      const isDivider = /^─{8,}/.test(line);
      const isPrompt = /^❯/.test(line);
      if (isDivider) {
        newContents.push({ type: 'divider' });
        continue;
      }
      if (isAnswer) {
        // Open a new assistant reply segment.
        if (this.inAssistant) {
          // Implicit close on next answer.
        }
        this.inAssistant = true;
        this.assistant = [line.replace(/^[●○]\s/, '')];
        const ct: ContentText = { type: 'text', text: this.assistant.join('\n') };
        newContents.push(ct);
        continue;
      }
      if (isPrompt) {
        this.inAssistant = false;
        continue;
      }

      // Default: append to current assistant.
      if (this.inAssistant) {
        this.assistant.push(line);
        const ct: ContentText = { type: 'text', text: this.assistant.join('\n') };
        newContents.push(ct);
      } else {
        // Free-floating info line: emit as standalone text.
        const ct: ContentText = { type: 'text', text: line };
        newContents.push(ct);
      }
    }

    return {
      contents: newContents,
      displayMode: replacedStatus ? 'replace-last' : 'chat',
    };
  }
}

/** A spinner line is one whose first non-space char is a spinner glyph
 *  followed by short descriptive text, e.g. "⠐ Cultivating… (2s · thinking)". */
function isSpinnerLine(line: string): string | null {
  for (const glyph of SPINNER_FRAMES) {
    if (line.startsWith(glyph)) return line;
  }
  // "storing thoughts" / "(esc to interrupt)" trailing text → not a spinner
  return null;
}

/** Strip SGR colour sequences from a single line so we can match by content. */
function stripSgr(line: string): string {
  return line.replace(/\[[\d;]*m/g, '').replace(/\[\??\d+[A-HJKSTfsulh]/g, '');
}

export function claudeDetector(): import('../types.js').AgentDetector {
  return {
    id: 'claude',
    priority: 10,
    detect(cmd, args, preview) {
      const base = (cmd + ' ' + args.join(' ')).toLowerCase();
      if (base.includes('claude')) return 'claude';
      if (preview.includes('●') || preview.includes('✻') || preview.includes('⏸')) return 'claude';
      return null;
    },
  };
}
