import { useState } from 'react';

/**
 * Reusable copy-to-clipboard command block.
 * Shows the command in a monospace <pre> with a Copy button on the right.
 */
export function CommandBlock({
  command,
  label,
  multiline,
}: {
  command: string;
  label?: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: select the text inside the <pre>.
      const range = document.createRange();
      const el = document.getElementById('cmd-' + hashString(command));
      if (el) {
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  const id = 'cmd-' + hashString(command);

  return (
    <div className="command-block">
      {label && <div className="command-label">{label}</div>}
      <div className="command-row">
        <pre
          id={id}
          className={multiline ? 'command-pre multi' : 'command-pre'}
        >
          {command}
        </pre>
        <button
          type="button"
          className={copied ? 'copy-btn copied' : 'copy-btn'}
          onClick={handleCopy}
          aria-label="Copy command"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/** Quick non-cryptographic hash for stable DOM ids. */
function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
