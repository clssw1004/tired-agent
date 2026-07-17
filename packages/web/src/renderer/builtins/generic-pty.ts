/**
 * Generic PTY Renderer — fallback for any command whose agent detector
 * doesn't claim it (cmd.exe, bash, unknown TUIs).
 *
 * Pipeline:
 *
 *   raw bytes → TextDecoder(utf-8) → drop OSC/DCS/cursor-CSI, keep SGR colour
 *            → array of { css, text } styled runs → StructuredContent[]
 *
 * Spinner-style overwrite frames (carriage returns redrawing the same line)
 * are dropped: only the final frame survives on each line.
 *
 * The result is always `displayMode: 'chat'` — content appends to the
 * open assistant segment.
 */

import type {
  ContentStyle,
  ContentText,
  StructuredContent,
} from '@tired-pc/protocol';
import type {
  AgentRenderer,
  DisplayMode,
  RenderContext,
  RenderOutput,
} from '../types.js';

const ESC_BYTE = String.fromCharCode(0x1B);
const BEL_BYTE = String.fromCharCode(0x07);

const ANSI_OSC_RE = new RegExp(
  ESC_BYTE + '\\][^' + BEL_BYTE + ']*(?:' + BEL_BYTE + '|' + ESC_BYTE + '\\\\)',
  'g',
);
const ANSI_DCS_RE = new RegExp(
  ESC_BYTE + '[PX^][^' + BEL_BYTE + ']*(?:' + BEL_BYTE + '|' + ESC_BYTE + '\\\\)',
  'g',
);
const ANSI_ESC_SHORT_RE = new RegExp(ESC_BYTE + '[\\x40-\\x5A\\\\\\-_]', 'g');
const CSI_PARSE_RE = new RegExp(
  ESC_BYTE + '\\[([\\d;]*)([A-HJKSTfghlmsu]?)',
  'g',
);

const ANSI_16: readonly string[] = [
  '#1c1c1c', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

function ansi256(i: number): string {
  if (i < 16) return ANSI_16[i] as string;
  if (i < 232) {
    const v = i - 16;
    const r = Math.floor(v / 36);
    const g = Math.floor((v % 36) / 6);
    const b = v % 6;
    const ch = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    return 'rgb(' + ch(r) + ',' + ch(g) + ',' + ch(b) + ')';
  }
  const v = 8 + (i - 232) * 10;
  return 'rgb(' + v + ',' + v + ',' + v + ')';
}

interface StyleState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  faint?: boolean;
  inverse?: boolean;
}

function applySgr(state: StyleState, params: number[]): StyleState {
  const next: StyleState = { ...state };
  let i = 0;
  while (i < params.length) {
    const p = params[i] || 0;
    switch (p) {
      case 0:
        next.fg = undefined; next.bg = undefined;
        next.bold = false; next.italic = false; next.underline = false;
        next.strike = false; next.faint = false; next.inverse = false;
        break;
      case 1: next.bold = true; break;
      case 2: next.faint = true; break;
      case 3: next.italic = true; break;
      case 4: next.underline = true; break;
      case 7: next.inverse = !next.inverse; break;
      case 9: next.strike = true; break;
      case 22: next.bold = false; break;
      case 23: next.italic = false; break;
      case 24: next.underline = false; break;
      case 27: next.inverse = false; break;
      case 29: next.strike = false; break;
      case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37:
        next.fg = ANSI_16[p - 30]; break;
      case 38:
        if (params[i + 1] === 5) { next.fg = ansi256(params[i + 2]); i += 2; }
        else if (params[i + 1] === 2) {
          next.fg = 'rgb(' + params[i + 2] + ',' + params[i + 3] + ',' + params[i + 4] + ')'; i += 4;
        }
        break;
      case 39: next.fg = undefined; break;
      case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47:
        next.bg = ANSI_16[p - 40]; break;
      case 48:
        if (params[i + 1] === 5) { next.bg = ansi256(params[i + 2]); i += 2; }
        else if (params[i + 1] === 2) {
          next.bg = 'rgb(' + params[i + 2] + ',' + params[i + 3] + ',' + params[i + 4] + ')'; i += 4;
        }
        break;
      case 49: next.bg = undefined; break;
      case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
        next.fg = ANSI_16[p - 90 + 8]; break;
      case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
        next.bg = ANSI_16[p - 100 + 8]; break;
      default: break;
    }
    i++;
  }
  return next;
}

function styleToCss(st: StyleState): ContentStyle {
  let fg = st.fg;
  let bg = st.bg;
  if (st.inverse && (fg || bg)) {
    const a = fg;
    fg = bg;
    bg = a;
  }
  const css: ContentStyle = {
    monospace: true,
    fontSize: 13,
  };
  if (fg) css.color = fg;
  if (bg) css.background = bg;
  if (st.bold) css.bold = true;
  if (st.italic) css.italic = true;
  const decor: string[] = [];
  if (st.underline) decor.push('underline');
  if (st.strike) decor.push('line-through');
  // ContentStyle doesn't carry textDecoration union; encode composed via a
  // string suffix in bold/italic pair flags. Renderer app maps these.
  if (decor.length) {
    if (decor.length === 1) {
      if (decor[0] === 'underline') css.underline = true;
      if (decor[0] === 'line-through') css.strikethrough = true;
    }
  }
  if (st.faint) css.faint = true;
  return css;
}

/** Walk raw text, splitting on SGR boundaries, returning styled runs. */
function parseStyledRuns(raw: string): Array<{ text: string; style: ContentStyle }> {
  let text = raw;
  text = text.replace(ANSI_OSC_RE, '');
  text = text.replace(ANSI_DCS_RE, '');
  text = text.replace(ANSI_ESC_SHORT_RE, '');

  const runs: Array<{ text: string; style: ContentStyle }> = [];
  let state: StyleState = {};
  let plainStart = 0;
  CSI_PARSE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CSI_PARSE_RE.exec(text)) !== null) {
    const final = m[2] || 'm';
    if (final === 'm') {
      if (m.index > plainStart) {
        const segText = text.slice(plainStart, m.index);
        if (segText) runs.push({ text: segText, style: styleToCss(state) });
      }
      const raw1 = m[1];
      const params = raw1.length === 0 ? [0] : raw1.split(';').map((s) => Number(s));
      state = applySgr(state, params);
      plainStart = CSI_PARSE_RE.lastIndex;
    } else {
      // Non-SGR CSI: splice the entire sequence out.
      const seqLen = m[0].length;
      text = text.slice(0, m.index) + text.slice(m.index + seqLen);
      CSI_PARSE_RE.lastIndex = m.index;
      plainStart = m.index;
    }
  }
  if (plainStart < text.length) {
    const segText = text.slice(plainStart);
    if (segText) runs.push({ text: segText, style: styleToCss(state) });
  }
  // Drop spinner-style \r overwrite: split on \n, keep only the LAST non-empty
  // chunk for each line. Lines without \n survive verbatim.
  const collapsed: Array<{ text: string; style: ContentStyle }> = [];
  for (const run of runs) {
    const parts = run.text.split('\n');
    const rebuilt: string[] = [];
    for (const p of parts) {
      const frames = p.split('\r');
      const last = frames[frames.length - 1] ?? '';
      rebuilt.push(last);
    }
    const newText = rebuilt.join('\n');
    if (newText) collapsed.push({ text: newText, style: run.style });
  }
  return collapsed;
}

export class GenericPtyRenderer implements AgentRenderer {
  readonly id = 'generic-pty';
  readonly name = 'Generic PTY';

  private buffer = '';

  processChunk(chunk: string, _ctx: RenderContext): RenderOutput {
    this.buffer += chunk;
    // Wait for a complete "\n" (or segment flush) to render — keeps the
    // bubble from flickering on every chunk.
    const lastNL = this.buffer.lastIndexOf('\n');
    if (lastNL < 0) return { contents: [], displayMode: 'chat' };
    const ready = this.buffer.slice(0, lastNL + 1);
    this.buffer = this.buffer.slice(lastNL + 1);
    const runs = parseStyledRuns(ready);
    const contents: StructuredContent[] = runs.map((r): ContentText => ({
      type: 'text',
      text: r.text,
      style: r.style,
    }));
    return { contents, displayMode: 'chat' };
  }

  flush(): RenderOutput {
    if (!this.buffer) return { contents: [], displayMode: 'chat' };
    const runs = parseStyledRuns(this.buffer);
    this.buffer = '';
    const contents: StructuredContent[] = runs.map((r): ContentText => ({
      type: 'text',
      text: r.text,
      style: r.style,
    }));
    return { contents, displayMode: 'chat' };
  }

  reset(): void {
    this.buffer = '';
  }
}

export function genericPtyDetector(): import('../types.js').AgentDetector {
  return {
    id: 'generic-pty',
    priority: -1,
    detect() {
      return 'generic-pty';
    },
  };
}
