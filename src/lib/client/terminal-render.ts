// Render a raw byte-ish stream into a plain string suitable for a <pre>,
// emulating the small subset of terminal control sequences that real-world
// bash tools actually use for streaming output:
//
//   \n             — newline (advance to a fresh line at col 0)
//   \r             — carriage return (cursor to col 0, next chars overwrite)
//   \b             — backspace (cursor left one, no erase)
//   \x1b[<n>K      — erase in line: 0=to end (default), 1=to start, 2=whole
//   \x1b[<...>m    — SGR / color — stripped silently
//   any other CSI  — stripped silently (so we don't render raw `[31m` junk)
//
// We deliberately don't emulate cursor up/down, absolute positioning, or
// alternate screen buffers — that's curses-tier and needs a real terminal
// emulator. Anything fancier than a progress bar / status line will degrade
// to a still-readable transcript rather than perfect rendering.

const ESC = 0x1b;

export function renderTerminal(input: string): string {
  if (!input) return "";
  // Fast path: nothing interesting to interpret.
  // eslint-disable-next-line no-control-regex
  if (!/[\r\b\x1b]/.test(input)) return input;

  const lines: string[] = [""];
  let row = 0;
  let col = 0;

  function writeChar(ch: string) {
    const line = lines[row];
    if (col === line.length) {
      lines[row] = line + ch;
    } else if (col < line.length) {
      lines[row] = line.slice(0, col) + ch + line.slice(col + 1);
    } else {
      // Cursor moved past EOL (rare). Pad with spaces.
      lines[row] = line + " ".repeat(col - line.length) + ch;
    }
    col++;
  }

  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 0x0a /* \n */) {
      row++;
      col = 0;
      if (row === lines.length) lines.push("");
      continue;
    }
    if (c === 0x0d /* \r */) {
      col = 0;
      continue;
    }
    if (c === 0x08 /* \b */) {
      if (col > 0) col--;
      continue;
    }
    if (c === ESC && input.charCodeAt(i + 1) === 0x5b /* '[' */) {
      // Parse CSI: ESC '[' <params> <final>
      let j = i + 2;
      while (j < input.length) {
        const cc = input.charCodeAt(j);
        // Final byte is in 0x40..0x7e; params/intermediates precede it.
        if (cc >= 0x40 && cc <= 0x7e) break;
        j++;
      }
      if (j >= input.length) {
        // Truncated CSI at end of buffer — drop it; a later chunk may complete it.
        return finalize(lines);
      }
      const params = input.slice(i + 2, j);
      const final = input[j];
      if (final === "K") {
        const n = params === "" ? 0 : parseInt(params, 10);
        const line = lines[row];
        if (n === 0) lines[row] = line.slice(0, col);
        else if (n === 1) lines[row] = " ".repeat(col) + line.slice(col);
        else if (n === 2) lines[row] = "";
      }
      // Other CSI sequences (SGR `m`, cursor moves, etc.) are silently
      // dropped — we don't render color and don't emulate movement.
      i = j;
      continue;
    }
    if (c === ESC) {
      // Non-CSI escape (e.g. ESC ] OSC, ESC ( charset). Skip the next
      // char as a minimal best-effort; we don't bother with full parsing.
      i++;
      continue;
    }
    writeChar(input[i]);
  }

  return finalize(lines);
}

function finalize(lines: string[]): string {
  return lines.join("\n");
}
