/**
 * Renderer entry — exports the public API for the Agent Rendering Engine.
 *
 * Apps wire this in once at module load:
 *
 *   import { initRenderers } from './renderer';
 *   initRenderers();   // registers GenericPtyRenderer + extends with others
 *
 * Then `ChatView` uses `defaultRegistry().select(...)` to pick a renderer.
 */

import type { ContentStyle, StructuredContent } from '@tired-pc/protocol';
import type { CSSProperties } from 'react';

export type {
  AgentRenderer,
  AgentDetector,
  RendererRegistration,
  RenderContext,
  RenderOutput,
  DisplayMode,
} from './types.js';

import { RendererRegistry, defaultRegistry } from './registry.js';
import { GenericPtyRenderer, genericPtyDetector } from './builtins/generic-pty.js';

export { RendererRegistry, defaultRegistry } from './registry.js';
export { GenericPtyRenderer, genericPtyDetector } from './builtins/generic-pty.js';

let _initialized = false;

/** Auto-register the default renderers (idempotent). */
export function initRenderers(): void {
  if (_initialized) return;
  _initialized = true;

  const reg = defaultRegistry();
  reg.register({
    detector: genericPtyDetector(),
    factory: () => new GenericPtyRenderer(),
  });
}

/** Build a React style object from a renderer-emitted ContentStyle. */
export function contentStyleToCss(style: ContentStyle | undefined): CSSProperties {
  if (!style) return {};
  const css: Record<string, unknown> = {};
  if (style.color) css.color = style.color;
  if (style.background) css.backgroundColor = style.background;
  if (style.bold) css.fontWeight = 600;
  if (style.italic) css.fontStyle = 'italic';
  const decor: string[] = [];
  if (style.underline) decor.push('underline');
  if (style.strikethrough) decor.push('line-through');
  if (decor.length) css.textDecoration = decor.join(' ');
  if (style.faint) css.opacity = 0.65;
  if (style.inverse) {
    const fg = css.color;
    const bg = css.backgroundColor;
    css.color = bg ?? 'inherit';
    css.backgroundColor = fg ?? 'transparent';
  }
  if (style.fontSize) css.fontSize = style.fontSize;
  if (style.monospace) {
    css.fontFamily =
      'ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace';
  }
  return css as CSSProperties;
}

/** Render a single content block as a React element (no React imports here
 *  — callers decide how to render their own DOM). */
export function describeContent(c: StructuredContent): {
  dom: string;
  style?: ContentStyle;
  text?: string;
  meta?: Record<string, unknown>;
} {
  switch (c.type) {
    case 'text':     return { dom: 'text',     text: c.text, style: c.style };
    case 'code':     return { dom: 'code',     text: c.code, meta: { language: c.language, display: c.display } };
    case 'divider':  return { dom: 'divider',  text: c.label };
    case 'status':   return { dom: 'status',   text: c.text, meta: { status: c.status, ephemeral: c.ephemeral } };
    case 'table':    return { dom: 'table',    text: c.headers.join(' | '), meta: { rowCount: c.rows.length } };
    case 'link':     return { dom: 'link',     text: c.text, meta: { href: c.url } };
    case 'image':    return { dom: 'image',    text: c.alt,  meta: { src: c.url } };
    case 'command':  return { dom: 'command',  text: c.raw,  meta: { parsed: c.parsed } };
    default:         return { dom: 'unknown' };
  }
}
