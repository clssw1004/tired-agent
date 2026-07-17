/**
 * Hex+ASCII dump mirroring the first N bytes of `xxd`/`hexdump -C`.
 * Used for local debugging of binary PTY streams — see CLSSW_DEBUG_SSE.
 */
export function hexAsciiDump(bytes: Uint8Array, max = 64): string {
  const slice = bytes.byteLength > max ? bytes.subarray(0, max) : bytes;
  const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = Array.from(slice, (b) =>
    b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.',
  ).join('');
  const trailing = bytes.byteLength > max ? ` …(+${bytes.byteLength - max})` : '';
  return `${hex}  |${ascii}|${trailing}`;
}
