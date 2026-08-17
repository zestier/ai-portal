// Shared clipboard helpers for the code/terminal "copy" buttons.
//
// Kept dependency-free and pure (aside from the actual clipboard write) so the
// trimming logic can be unit-tested without a DOM, and so both the
// `copyableCodeBlocks` action (which injects buttons into {@html} output) and
// `TerminalBlock.svelte` (which hosts its own button in real markup) can share
// the same copy semantics.

/**
 * Trim at most ONE trailing newline from `text`. A trailing `\r\n` is treated
 * as a single newline (both characters removed); a lone `\n` removes just that
 * character. Any further interior or leading newlines are preserved exactly.
 */
export function trimOneTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/**
 * Write `text` to the clipboard, returning `true` on success and `false` if the
 * Clipboard API is unavailable (e.g. a non-secure context where
 * `navigator.clipboard` is `undefined`) or the write throws. Callers surface a
 * visible "Copy failed" state on `false` rather than silently swallowing it.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
