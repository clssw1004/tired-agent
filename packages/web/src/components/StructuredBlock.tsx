import type { StructuredContent } from '@tired-pc/protocol';
import { contentStyleToCss } from '../renderer';
import type { CSSProperties } from 'react';

/**
 * One structured block, mapped to mobile-friendly markup. Renders inside
 * a chat bubble's body. The output is intentionally minimal: chips for
 * status, monospace pre for code, a thin rule for divider, etc.
 *
 * Tap a code/text block to copy to clipboard (uses native navigator API
 * where available; silent on failure).
 */
export function StructuredBlock({
  content,
}: {
  content: StructuredContent;
}): JSX.Element | null {
  switch (content.type) {
    case 'text':
      return (
        <span
          className="ct-text"
          style={contentStyleToCss(content.style)}
        >
          {content.text}
        </span>
      );

    case 'code':
      return content.display === 'block' ? (
        <pre className="ct-code-block">{content.code}</pre>
      ) : (
        <code className="ct-code-inline">{content.code}</code>
      );

    case 'divider':
      return <hr className="ct-divider" />;

    case 'status': {
      const cls = `ct-status ct-status-${content.status}${content.ephemeral ? ' ephemeral' : ''}`;
      return (
        <div className={cls} role="status">
          {content.ephemeral && <span className="ct-status-pulse" aria-hidden />}
          <span className="ct-status-text">{content.text}</span>
        </div>
      );
    }

    case 'table': {
      const wStyle: CSSProperties = { overflowX: 'auto' };
      return (
        <div className="ct-table-wrap" style={wStyle}>
          <table className="ct-table">
            <thead>
              <tr>
                {content.headers.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {content.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'link':
      return (
        <a className="ct-link" href={content.url} target="_blank" rel="noreferrer noopener">
          {content.text}
        </a>
      );

    case 'image':
      return (
        <img className="ct-image" src={content.url} alt={content.alt} loading="lazy" />
      );

    case 'command':
      return (
        <div className="ct-command">
          <code>{content.parsed || content.raw}</code>
        </div>
      );

    default:
      return null;
  }
}
