import { describe, it, expect } from "vitest";
import { renderTerminal } from "../../src/lib/client/terminal-render";

describe("renderTerminal", () => {
  it("passes plain text through unchanged", () => {
    expect(renderTerminal("hello\nworld\n")).toBe("hello\nworld\n");
  });

  it("handles \\r as in-place overwrite", () => {
    // Progress-bar style: each frame redraws the same line.
    const frames = ["[#...] 20%", "[##..] 40%", "[###.] 60%", "[####] 80%"];
    const stream = frames.map((f) => "\r" + f).join("");
    expect(renderTerminal(stream)).toBe("[####] 80%");
  });

  it("preserves earlier lines when \\r only resets current line", () => {
    // Overwrites the first 8 chars of "working..." with "done too", leaving
    // the trailing ".." in place. Bash tools that want a clean redraw need
    // to emit a clear-line (\x1b[2K) along with the CR.
    expect(renderTerminal("done\nworking...\rdone too")).toBe(
      "done\ndone too..",
    );
  });

  it("partial overwrite only replaces leading chars", () => {
    // "ABCDE" then \r then "xy" → "xyCDE"
    expect(renderTerminal("ABCDE\rxy")).toBe("xyCDE");
  });

  it("CSI 2K clears the whole line", () => {
    expect(renderTerminal("oldtext\x1b[2K\rnew")).toBe("new");
  });

  it("CSI K (default 0) erases from cursor to end", () => {
    expect(renderTerminal("abcdef\rxyz\x1b[K")).toBe("xyz");
  });

  it("CSI 1K erases from start to cursor", () => {
    expect(renderTerminal("abcdef\rxyz\x1b[1K")).toBe("   def");
  });

  it("strips SGR color codes", () => {
    expect(renderTerminal("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  it("handles backspace", () => {
    expect(renderTerminal("abc\b\bxy")).toBe("axy");
  });

  it("drops a truncated CSI at end of buffer", () => {
    // A later chunk could complete the sequence; for now, render what we have.
    expect(renderTerminal("hello\x1b[")).toBe("hello");
  });

  it("handles a realistic progress bar with clear-line + CR", () => {
    const out = [
      "[....] 0%",
      "[#...] 25%",
      "[##..] 50%",
      "[###.] 75%",
      "[####] 100%",
    ]
      .map((f) => "\x1b[2K\r" + f)
      .join("");
    expect(renderTerminal(out)).toBe("[####] 100%");
  });
});
