/**
 * ClaudeCommandsBar — quick-launch buttons for common Claude CLI slash commands.
 *
 * Why this exists: typing `/clear`, `/compact`, `/cost`, etc. from a phone or
 * in a long TUI conversation is friction. The bar surfaces the most-used
 * commands as one-tap chips; clicking sends the text + `\r` to the PTY the
 * same way the user would have typed and submitted it.
 *
 * Scope: this is purely a UI accelerator. The list mirrors what Claude Code
 * CLI actually accepts (see https://docs.claude.com/en/docs/claude-code/cli).
 * If the user runs a command Claude doesn't recognize, the bar doesn't care —
 * the bytes still flow to the underlying CLI. If a command name changes or
 * goes away in a future Claude release, the bar still sends the bytes; the
 * user just sees Claude's standard "unknown command" reply.
 *
 * Layout: horizontal scrollable chip row, similar to .special-keys but with
 * the chip aesthetic from .argument-chip (used by SessionCreatePage). Hidden
 * in structured (chat) mode because ClaudeChatView already exposes these via
 * the timeline UI; this bar is strictly for PTY mode.
 */

interface Command {
  /** Slash command text, including the leading `/`. Sent verbatim. */
  command: string;
  /** Display label on the chip (typically the command itself, no slash). */
  label: string;
  /** Tooltip / a11y description shown on hover. */
  hint: string;
  /** Optional emoji or short glyph prepended to the chip label. */
  glyph?: string;
}

/** Curated set of Claude Code CLI slash commands the user is most likely to
 *  reach for. Ordered roughly by frequency; the bar scrolls horizontally so
 *  the ordering is more about scanning than priority. */
const COMMANDS: ReadonlyArray<Command> = [
  { command: '/help', label: 'help', hint: 'Show Claude CLI help', glyph: '?' },
  { command: '/clear', label: 'clear', hint: 'Clear conversation history', glyph: '⌫' },
  { command: '/compact', label: 'compact', hint: 'Compact conversation context', glyph: '↻' },
  { command: '/cost', label: 'cost', hint: 'Show token usage / cost', glyph: '$' },
  { command: '/doctor', label: 'doctor', hint: 'Diagnose Claude installation', glyph: '✚' },
  { command: '/init', label: 'init', hint: 'Initialize CLAUDE.md for this repo', glyph: '★' },
  { command: '/resume', label: 'resume', hint: 'Resume a previous conversation', glyph: '↺' },
  { command: '/login', label: 'login', hint: 'Switch Anthropic account', glyph: '⇄' },
  { command: '/logout', label: 'logout', hint: 'Log out of current account', glyph: '⎋' },
];

interface Props {
  /** When true, all chips are disabled (e.g. session has exited). */
  disabled?: boolean;
  /** Called when a chip is tapped. The host forwards `text + '\r'` to the PTY. */
  onCommand: (text: string) => void;
}

export function ClaudeCommandsBar({ disabled, onCommand }: Props) {
  return (
    <div className="claude-commands" role="toolbar" aria-label="Claude slash commands">
      {COMMANDS.map((c) => (
        <button
          key={c.command}
          type="button"
          className="claude-command-chip"
          disabled={disabled}
          title={c.hint}
          onClick={() => onCommand(c.command)}
        >
          {c.glyph && <span className="claude-command-glyph" aria-hidden>{c.glyph}</span>}
          <span>{c.label}</span>
        </button>
      ))}
    </div>
  );
}