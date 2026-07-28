/**
 * Claude Code project directory name encoding/decoding.
 *
 * Claude Code encodes the project directory path into a flat directory
 * name to avoid filesystem separators and (on Windows) the drive colon.
 *
 * ## Encoding scheme
 *
 *   **Windows:**
 *   ```
 *   "C:\wspec\tired_agent_app" → "C--wspec--tired_agent_app"
 *   ```
 *   The drive letter colon is removed, then every `\` becomes `--`.
 *
 *   **POSIX (Linux, macOS):**
 *   ```
 *   "/home/dev/my-project" → "home-dev-my-project"
 *   ```
 *   The leading `/` is stripped, then every `/` becomes `-`.
 *
 * ## Limitation
 *
 * Paths containing literal `-` characters on POSIX (or `--` substrings on
 * Windows) will be ambiguous after encoding because the separator token
 * (`-` on POSIX, `--` on Windows) is the same as what a literal hyphen
 * produces.  For the intended use — encoding Claude Code project directory
 * paths, which rarely contain these patterns — this is acceptable.
 *
 * @module claude-path
 */

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Encode an absolute filesystem path into a Claude Code project directory
 * name suitable for use as a single path-component.
 *
 * @param path  - Absolute filesystem path to encode.
 * @param platform_ - Platform identifier (defaults to `process.platform`).
 *                    Exposed for testing; pass `"win32"` or `"darwin"` etc.
 * @returns The encoded directory name.
 */
export function encodeClaudeProjectPath(
  path: string,
  platform_?: string,
): string {
  const isWin = (platform_ ?? process.platform) === 'win32';
  let encoded: string;

  if (isWin) {
    // Windows: map `:` `\` `_` each to `-`. (Verified against Claude Code's
    // actual `~/.claude/projects/` directory naming convention.)
    //   "C:\\wspec\\tired_agent_app" → "C--wspec-tired-agent-app"
    encoded = path.replace(/[:\\_]/g, '-');
  } else {
    // Strip leading /, replace remaining / with -
    encoded = path.replace(/^\//, '').replace(/\//g, '-');
  }

  return encoded;
}

/**
 * Decode a Claude Code project directory name back into the original
 * absolute filesystem path.
 *
 * @param encoded - The encoded directory name to decode.
 * @param platform_ - Platform identifier (defaults to `process.platform`).
 *                    Exposed for testing; pass `"win32"` or `"darwin"` etc.
 * @returns The decoded absolute filesystem path.
 */
export function decodeClaudeProjectPath(
  encoded: string,
  platform_?: string,
): string {
  const isWin = (platform_ ?? process.platform) === 'win32';

  if (isWin) {
    // Decoding is lossy because the encoder collapses `:` `\` `_` into
    // the same `-`. We do a best-effort decode: the leading `-` after the
    // drive letter becomes `:`, and every remaining `-` becomes `_`.
    // (An exact round-trip is impossible; encode/grep-back the file
    // system name is the only way to recover the original.)
    return encoded.replace(/^([A-Za-z])-/, '$1:').replace(/-/g, '_');
  } else {
    // Restore from - to /
    return '/' + encoded.replace(/-/g, '/');
  }
}
