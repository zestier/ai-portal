import { describe, it, expect } from "vitest";
import {
  decodeScope,
  encodeScope,
  stableScopeKey,
} from "../../src/lib/permissions/scope-codec";
import type { GrantScope } from "../../src/lib/permissions/scope-types";

function roundtrip(scope: GrantScope) {
  const enc = encodeScope(scope);
  const dec = decodeScope(enc);
  expect(dec).toEqual(scope);
}

describe("scope-codec roundtrip", () => {
  it("any", () => {
    roundtrip({ kind: "any" });
  });

  it("shell minimal", () => {
    roundtrip({ kind: "shell", rule: { command: [{ token: "ls" }] } });
  });

  it("shell full", () => {
    roundtrip({
      kind: "shell",
      rule: {
        command: [
          {
            token: "git",
            options: {
              allow: [{ name: "-C", kind: "option", value: { kind: "any" } }],
              deny: ["--git-dir"],
            },
          },
          {
            token: "remote",
            options: { allow: [{ name: "-v", kind: "flag" }] },
          },
          {
            token: "show",
            options: {
              allow: [
                { name: "-n", kind: "flag" },
                { name: "--oneline", kind: "flag" },
              ],
              deny: ["--format"],
            },
          },
        ],
        positionals: { kind: "workspace-paths" },
      },
    });
  });

  it("shell with pipeline=must", () => {
    roundtrip({
      kind: "shell",
      rule: { command: [{ token: "grep" }], pipeline: "must" },
    });
  });

  it("shell with pipeline=forbid", () => {
    roundtrip({
      kind: "shell",
      rule: {
        command: [{ token: "cat" }],
        pipeline: "forbid",
        positionals: { kind: "any" },
      },
    });
  });

  it("shell with session-workspace-paths positionals", () => {
    roundtrip({
      kind: "shell",
      rule: {
        command: [{ token: "cat" }],
        positionals: { kind: "session-workspace-paths" },
      },
    });
  });

  it("shell with fs-deferred positionals", () => {
    roundtrip({
      kind: "shell",
      rule: {
        command: [{ token: "cat" }],
        positionals: { kind: "readable-paths" },
      },
    });
    roundtrip({
      kind: "shell",
      rule: {
        command: [{ token: "tee" }],
        positionals: { kind: "writable-paths" },
      },
    });
    // The two levers compose: "exactly one path my read grants permit".
    roundtrip({
      kind: "shell",
      rule: {
        command: [{ token: "cat" }],
        positionals: { kind: "readable-paths" },
        positionalCount: { min: 1, max: 1 },
      },
    });
  });

  it("shell with a positional count range", () => {
    roundtrip({
      kind: "shell",
      rule: {
        command: [{ token: "grep" }],
        positionals: { kind: "any" },
        positionalCount: { max: 1 },
        pipeline: "pipe-target",
      },
    });
    roundtrip({
      kind: "shell",
      rule: {
        command: [{ token: "cat" }],
        positionals: { kind: "workspace-paths" },
        positionalCount: { min: 1, max: 1 },
      },
    });
  });

  it("fs variants", () => {
    roundtrip({
      kind: "fs",
      rule: { kind: "path", root: "workspace", behavior: "any" },
      perms: ["read"],
    });
    roundtrip({
      kind: "fs",
      rule: { kind: "path", root: "session-workspace", behavior: "any" },
      perms: ["read"],
    });
    roundtrip({
      kind: "fs",
      rule: {
        kind: "path",
        root: "absolute",
        behavior: "exact",
        value: "/tmp/x",
      },
    });
    roundtrip({
      kind: "fs",
      rule: {
        kind: "path",
        root: "workspace",
        behavior: "glob",
        value: "src/**",
      },
      perms: ["read", "write"],
    });
    roundtrip({
      kind: "fs",
      rule: {
        kind: "path",
        root: "absolute",
        behavior: "prefix",
        value: "/home/me/.config/foo",
      },
      perms: ["read"],
    });
  });

  it("url variants", () => {
    roundtrip({ kind: "url", rule: { kind: "exact", url: "https://a" } });
    roundtrip({ kind: "url", rule: { kind: "host", host: "api.github.com" } });
    roundtrip({
      kind: "url",
      rule: { kind: "host-suffix", suffix: "github.com" },
    });
  });
});

describe("stableScopeKey", () => {
  it("ignores object key insertion order", () => {
    const a: GrantScope = {
      kind: "fs",
      perms: ["read"],
      rule: { kind: "path", root: "session-workspace", behavior: "any" },
    };
    const b = {
      kind: "fs",
      rule: { kind: "path", root: "session-workspace", behavior: "any" },
      perms: ["read"],
    } as GrantScope;
    expect(stableScopeKey(a)).toBe(stableScopeKey(b));
  });
});

describe("scope-codec decode — rejects malformed input", () => {
  it.each([
    null,
    "",
    "not json",
    "[]",
    "{}",
    '{"kind":"shell"}',
    '{"kind":"shell","rule":{}}',
    '{"kind":"shell","rule":{"command":[]}}',
    '{"kind":"shell","rule":{"command":[{"token":""}]}}',
    '{"kind":"shell","rule":{"command":[{"token":"/bin/ls"}]}}',
    '{"kind":"shell","rule":{"command":[{"token":"./ls"}]}}',
    '{"kind":"shell","rule":{"argv0":"git","subcommands":[1]}}',
    '{"kind":"shell","rule":{"command":[{"token":"git","options":{"allow":[1]}}]}}',
    '{"kind":"shell","rule":{"command":[{"token":"git","options":{"allow":[{"name":"-C","kind":"option","value":{"kind":"weird"}}]}}]}}',
    '{"kind":"shell","rule":{"command":[{"token":"git"}],"positionals":{"kind":"foo"}}}',
    '{"kind":"shell","rule":{"command":[{"token":"grep"}],"positionalCount":{}}}',
    '{"kind":"shell","rule":{"command":[{"token":"grep"}],"positionalCount":{"max":-1}}}',
    '{"kind":"shell","rule":{"command":[{"token":"grep"}],"positionalCount":{"max":1.5}}}',
    '{"kind":"shell","rule":{"command":[{"token":"grep"}],"positionalCount":{"max":"1"}}}',
    '{"kind":"shell","rule":{"command":[{"token":"grep"}],"positionalCount":{"min":2,"max":1}}}',
    // pattern-only was replaced by the orthogonal positionalCount range.
    '{"kind":"shell","rule":{"command":[{"token":"grep"}],"positionals":{"kind":"pattern-only"}}}',
    '{"kind":"fs","rule":{"kind":"exact"}}',
    '{"kind":"fs","rule":{"kind":"exact","path":"/tmp/x"}}',
    '{"kind":"fs","rule":{"kind":"workspace"}}',
    '{"kind":"fs","rule":{"kind":"workspace-glob"}}',
    '{"kind":"fs","rule":{"kind":"workspace-glob","glob":"src/**"}}',
    '{"kind":"fs","rule":{"kind":"workspace"},"perms":["delete"]}',
    '{"kind":"fs","rule":{"kind":"prefix"}}',
    '{"kind":"fs","rule":{"kind":"prefix","path":""}}',
    '{"kind":"fs","rule":{"kind":"path","root":"absolute","behavior":"any"}}',
    '{"kind":"fs","rule":{"kind":"path","root":"absolute","behavior":"exact","value":"relative"}}',
    '{"kind":"fs","rule":{"kind":"path","root":"workspace","behavior":"glob","value":"/tmp/**"}}',
    '{"kind":"fs","rule":{"kind":"path","root":"workspace","behavior":"any","value":"src/**"}}',
    '{"kind":"fs","rule":{"kind":"path","root":"workspace","behavior":"any"},"extra":true}',
    '{"kind":"url","rule":{"kind":"exact"}}',
    '{"kind":"url","rule":{"kind":"host","host":""}}',
    '{"kind":"weird"}',
  ])("rejects %j", (input) => {
    expect(decodeScope(input as string)).toBeNull();
  });
});
