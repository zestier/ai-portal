import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fsScopeMatches,
  tokenGlobMatches,
} from "../../../src/lib/server/permissions/predicates/fs";
import { urlScopeMatches } from "../../../src/lib/server/permissions/predicates/url";

let ws: string;

beforeAll(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "portal-fs-url-pred-")));
  mkdirSync(join(ws, "src"));
  writeFileSync(join(ws, "src", "a.ts"), "x");
  writeFileSync(join(ws, "src", "b.ts"), "x");
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe("fs predicate", () => {
  it("exact rule matches only the exact path", () => {
    const scope = {
      kind: "fs" as const,
      rule: {
        kind: "path" as const,
        root: "absolute" as const,
        behavior: "exact" as const,
        value: "/tmp/x",
      },
    };
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: "/tmp/x",
        workspaceRoots: [ws],
      }),
    ).toBe(true);
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: "/tmp/y",
        workspaceRoots: [ws],
      }),
    ).toBe(false);
  });

  it("workspace rule matches anything inside the workspace", () => {
    const scope = {
      kind: "fs" as const,
      rule: {
        kind: "path" as const,
        root: "workspace" as const,
        behavior: "any" as const,
      },
    };
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: join(ws, "src", "a.ts"),
        workspaceRoots: [ws],
      }),
    ).toBe(true);
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: "/etc/passwd",
        workspaceRoots: [ws],
      }),
    ).toBe(false);
  });

  it("workspace glob requires both containment and glob match", () => {
    const scope = {
      kind: "fs" as const,
      rule: {
        kind: "path" as const,
        root: "workspace" as const,
        behavior: "glob" as const,
        value: "src/**",
      },
    };
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: join(ws, "src", "a.ts"),
        workspaceRoots: [ws],
      }),
    ).toBe(true);
    // File is in workspace but doesn't match the glob.
    writeFileSync(join(ws, "top.txt"), "x");
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: join(ws, "other.txt"),
        workspaceRoots: [ws],
      }),
    ).toBe(false);
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: join(ws, "src", "..", "top.txt"),
        workspaceRoots: [ws],
      }),
    ).toBe(false);
  });

  it("absolute glob matches absolute targets", () => {
    const scope = {
      kind: "fs" as const,
      rule: {
        kind: "path" as const,
        root: "absolute" as const,
        behavior: "glob" as const,
        value: `${ws}/src/**`,
      },
    };
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: join(ws, "src", "a.ts"),
        workspaceRoots: [ws],
      }),
    ).toBe(true);
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: join(ws, "top.txt"),
        workspaceRoots: [ws],
      }),
    ).toBe(false);
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: join(ws, "src", "..", "top.txt"),
        workspaceRoots: [ws],
      }),
    ).toBe(false);
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: "/etc/passwd",
        workspaceRoots: [ws],
      }),
    ).toBe(false);
  });

  it("absolute glob matches canonical paths so symlink escapes do not inherit lexical grants", () => {
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "portal-fs-abs-glob-outside-")),
    );
    try {
      writeFileSync(join(outside, "secret.txt"), "x");
      symlinkSync(outside, join(ws, "src", "escape"));
      const scope = {
        kind: "fs" as const,
        rule: {
          kind: "path" as const,
          root: "absolute" as const,
          behavior: "glob" as const,
          value: `${ws}/src/**`,
        },
      };
      expect(
        fsScopeMatches(scope, {
          permissionKind: "read",
          target: join(ws, "src", "escape", "secret.txt"),
          workspaceRoots: [ws],
        }),
      ).toBe(false);
    } finally {
      rmSync(join(ws, "src", "escape"), { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("perms filter restricts the request kinds the grant covers", () => {
    const scope = {
      kind: "fs" as const,
      perms: ["read" as const],
      rule: {
        kind: "path" as const,
        root: "workspace" as const,
        behavior: "any" as const,
      },
    };
    const target = join(ws, "src", "a.ts");
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target,
        workspaceRoots: [ws],
      }),
    ).toBe(true);
    expect(
      fsScopeMatches(scope, {
        permissionKind: "write",
        target,
        workspaceRoots: [ws],
      }),
    ).toBe(false);
  });

  it("workspace any / glob fail closed without a workspace root", () => {
    expect(
      fsScopeMatches(
        {
          kind: "fs",
          rule: { kind: "path", root: "workspace", behavior: "any" },
        },
        { permissionKind: "read", target: "/tmp/x", workspaceRoots: null },
      ),
    ).toBe(false);
    expect(
      fsScopeMatches(
        {
          kind: "fs",
          rule: {
            kind: "path",
            root: "workspace",
            behavior: "glob",
            value: "**",
          },
        },
        { permissionKind: "read", target: "/tmp/x", workspaceRoots: null },
      ),
    ).toBe(false);
  });

  it("session-workspace rule matches only inside the SDK session workspace", () => {
    const scope = {
      kind: "fs" as const,
      rule: {
        kind: "path" as const,
        root: "session-workspace" as const,
        behavior: "any" as const,
      },
    };
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: join(ws, "src", "a.ts"),
        workspaceRoots: null,
        sessionWorkspaceRoot: ws,
      }),
    ).toBe(true);
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: "/etc/passwd",
        workspaceRoots: [ws],
        sessionWorkspaceRoot: ws,
      }),
    ).toBe(false);
    expect(
      fsScopeMatches(scope, {
        permissionKind: "read",
        target: join(ws, "src", "a.ts"),
        workspaceRoots: [ws],
        sessionWorkspaceRoot: null,
      }),
    ).toBe(false);
  });

  describe("prefix rule", () => {
    let outside: string;
    beforeAll(() => {
      outside = realpathSync(mkdtempSync(join(tmpdir(), "portal-fs-prefix-")));
      mkdirSync(join(outside, "sub"));
      writeFileSync(join(outside, "sub", "a.txt"), "x");
    });
    afterAll(() => rmSync(outside, { recursive: true, force: true }));

    it("matches the prefix itself and descendants", () => {
      const scope = {
        kind: "fs" as const,
        rule: {
          kind: "path" as const,
          root: "absolute" as const,
          behavior: "prefix" as const,
          value: outside,
        },
      };
      expect(
        fsScopeMatches(scope, {
          permissionKind: "read",
          target: outside,
          workspaceRoots: null,
        }),
      ).toBe(true);
      expect(
        fsScopeMatches(scope, {
          permissionKind: "read",
          target: join(outside, "sub", "a.txt"),
          workspaceRoots: null,
        }),
      ).toBe(true);
    });

    it("rejects paths outside the prefix and sibling-prefix collisions", () => {
      const scope = {
        kind: "fs" as const,
        rule: {
          kind: "path" as const,
          root: "absolute" as const,
          behavior: "prefix" as const,
          value: outside,
        },
      };
      expect(
        fsScopeMatches(scope, {
          permissionKind: "read",
          target: "/etc/passwd",
          workspaceRoots: null,
        }),
      ).toBe(false);
      // Sibling whose name shares the prefix's basename as a prefix
      // substring must not be treated as inside.
      expect(
        fsScopeMatches(scope, {
          permissionKind: "read",
          target: `${outside}-evil/file`,
          workspaceRoots: null,
        }),
      ).toBe(false);
    });

    it("handles not-yet-existing descendants via parent-fallback realpath", () => {
      const scope = {
        kind: "fs" as const,
        rule: {
          kind: "path" as const,
          root: "absolute" as const,
          behavior: "prefix" as const,
          value: outside,
        },
      };
      expect(
        fsScopeMatches(scope, {
          permissionKind: "write",
          target: join(outside, "does-not-exist-yet", "new.txt"),
          workspaceRoots: null,
        }),
      ).toBe(true);
    });

    it("rejects relative prefix or target paths (no working directory anchor)", () => {
      const scope = {
        kind: "fs" as const,
        rule: {
          kind: "path" as const,
          root: "absolute" as const,
          behavior: "prefix" as const,
          value: "relative",
        },
      };
      expect(
        fsScopeMatches(scope, {
          permissionKind: "read",
          target: outside,
          workspaceRoots: null,
        }),
      ).toBe(false);
      const absScope = {
        kind: "fs" as const,
        rule: {
          kind: "path" as const,
          root: "absolute" as const,
          behavior: "prefix" as const,
          value: outside,
        },
      };
      expect(
        fsScopeMatches(absScope, {
          permissionKind: "read",
          target: "relative/path",
          workspaceRoots: null,
        }),
      ).toBe(false);
    });

    it("honors the perms filter", () => {
      const scope = {
        kind: "fs" as const,
        perms: ["read" as const],
        rule: {
          kind: "path" as const,
          root: "absolute" as const,
          behavior: "prefix" as const,
          value: outside,
        },
      };
      expect(
        fsScopeMatches(scope, {
          permissionKind: "read",
          target: join(outside, "sub", "a.txt"),
          workspaceRoots: null,
        }),
      ).toBe(true);
      expect(
        fsScopeMatches(scope, {
          permissionKind: "write",
          target: join(outside, "sub", "a.txt"),
          workspaceRoots: null,
        }),
      ).toBe(false);
    });
  });
});

describe("tokenGlobMatches", () => {
  it("* matches within one segment", () => {
    expect(tokenGlobMatches("src/*.ts", "src/a.ts")).toBe(true);
    expect(tokenGlobMatches("src/*.ts", "src/a/b.ts")).toBe(false);
  });

  it("** matches any number of segments", () => {
    expect(tokenGlobMatches("src/**", "src/a.ts")).toBe(true);
    expect(tokenGlobMatches("src/**", "src/a/b/c.ts")).toBe(true);
    expect(tokenGlobMatches("src/**", "other/a.ts")).toBe(false);
  });

  it("**/ allows zero leading segments", () => {
    expect(tokenGlobMatches("**/foo.ts", "foo.ts")).toBe(true);
    expect(tokenGlobMatches("**/foo.ts", "a/b/foo.ts")).toBe(true);
  });

  it("trailing ** after / crosses directory boundaries", () => {
    expect(
      tokenGlobMatches("/data/project/**", "/data/project/secret.key"),
    ).toBe(true);
    expect(
      tokenGlobMatches("/data/project/**", "/data/project/a/b/secret.key"),
    ).toBe(true);
  });

  it("trailing ** not preceded by / stays within a single segment", () => {
    expect(
      tokenGlobMatches("/data/project**", "/data/project-evil/secret.key"),
    ).toBe(false);
    expect(tokenGlobMatches("/data/project**", "/data/project-x")).toBe(true);
    expect(tokenGlobMatches("/data/project**", "/data/project")).toBe(true);
  });
});

describe("url predicate", () => {
  it("exact rule matches by full string", () => {
    const scope = {
      kind: "url" as const,
      rule: { kind: "exact" as const, url: "https://api.github.com/x" },
    };
    expect(urlScopeMatches(scope, { url: "https://api.github.com/x" })).toBe(
      true,
    );
    expect(urlScopeMatches(scope, { url: "https://api.github.com/y" })).toBe(
      false,
    );
  });

  it("host rule matches just the host", () => {
    const scope = {
      kind: "url" as const,
      rule: { kind: "host" as const, host: "api.github.com" },
    };
    expect(urlScopeMatches(scope, { url: "https://api.github.com/a/b" })).toBe(
      true,
    );
    expect(urlScopeMatches(scope, { url: "https://example.com/x" })).toBe(
      false,
    );
    expect(urlScopeMatches(scope, { url: "not a url" })).toBe(false);
  });

  it("host-suffix matches the host and subdomains, not sibling hosts", () => {
    const scope = {
      kind: "url" as const,
      rule: { kind: "host-suffix" as const, suffix: "github.com" },
    };
    expect(urlScopeMatches(scope, { url: "https://github.com/a" })).toBe(true);
    expect(urlScopeMatches(scope, { url: "https://api.github.com/a" })).toBe(
      true,
    );
    expect(urlScopeMatches(scope, { url: "https://evilgithub.com/a" })).toBe(
      false,
    );
  });

  it("host rule with mixed-case legacy value still matches lowercased runtime host", () => {
    const scope = {
      kind: "url" as const,
      rule: { kind: "host" as const, host: "API.GitHub.Com" },
    };
    expect(urlScopeMatches(scope, { url: "https://api.github.com/a/b" })).toBe(
      true,
    );
    expect(urlScopeMatches(scope, { url: "https://example.com/x" })).toBe(
      false,
    );
  });

  it("host-suffix rule with mixed-case legacy value still matches", () => {
    const scope = {
      kind: "url" as const,
      rule: { kind: "host-suffix" as const, suffix: "GitHub.Com" },
    };
    expect(urlScopeMatches(scope, { url: "https://github.com/a" })).toBe(true);
    expect(urlScopeMatches(scope, { url: "https://api.github.com/a" })).toBe(
      true,
    );
    expect(urlScopeMatches(scope, { url: "https://evilgithub.com/a" })).toBe(
      false,
    );
  });
});
