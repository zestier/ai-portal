// Typed-input handling for project actions (Phase 2).
//
// An action may declare typed `inputs` (string/enum/number). At run time the
// caller supplies values; we validate them against the declarations and
// substitute them into the steps' `args` ONLY — never the command, and never
// via a shell (the runner stays `shell: false`). Because substitution targets
// whole argv elements, a value containing spaces/quotes/`$(...)`/newlines is
// passed as a single literal argument and cannot break out into shell syntax.

import type { ActionInput, ActionStep } from "./config";

// `{{ NAME }}` placeholder. Names match the input-name grammar (a leading
// letter/underscore then word chars). Whitespace inside the braces is allowed
// and ignored so `{{ foo }}` and `{{foo}}` are equivalent.
export const INPUT_TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// Bound a single substituted value so a malicious/buggy caller can't blow up
// argv size. Generous for realistic inputs (paths, refs, messages).
const MAX_INPUT_LENGTH = 8192;

/** All distinct input names referenced by `{{...}}` tokens in `text`. */
export function tokensIn(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(INPUT_TOKEN)) names.add(match[1]);
  return [...names];
}

export type ResolveInputsResult =
  { ok: true; values: Record<string, string> } | { ok: false; error: string };

/**
 * Validate caller-supplied raw values against an action's declared inputs and
 * normalize them to the string form used for argv substitution. Fail-closed:
 *  - unknown keys (not a declared input) are rejected,
 *  - a required input with neither a value nor a default is rejected,
 *  - enum values must be one of `options`; numbers must be finite; strings are
 *    length-capped.
 * An optional input left unset resolves to the empty string so its token
 * substitutes away cleanly.
 */
export function resolveInputValues(
  inputs: readonly ActionInput[],
  raw: Record<string, unknown> = {},
): ResolveInputsResult {
  const declared = new Map(inputs.map((i) => [i.name, i]));
  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) {
      return { ok: false, error: `unknown input "${key}"` };
    }
  }

  const values: Record<string, string> = {};
  for (const input of inputs) {
    const provided = raw[input.name];
    const hasProvided =
      provided !== undefined && provided !== null && provided !== "";
    const source = hasProvided ? provided : input.default;

    if (source === undefined || source === null || source === "") {
      if (input.required) {
        return { ok: false, error: `input "${input.name}" is required` };
      }
      values[input.name] = "";
      continue;
    }

    switch (input.type) {
      case "enum": {
        const str = String(source);
        if (!input.options?.includes(str)) {
          return {
            ok: false,
            error: `input "${input.name}" must be one of: ${(input.options ?? []).join(", ")}`,
          };
        }
        values[input.name] = str;
        break;
      }
      case "number": {
        const num =
          typeof source === "number" ? source : Number(String(source).trim());
        if (!Number.isFinite(num)) {
          return { ok: false, error: `input "${input.name}" must be a number` };
        }
        values[input.name] = String(num);
        break;
      }
      default: {
        if (typeof source !== "string") {
          return { ok: false, error: `input "${input.name}" must be a string` };
        }
        if (source.length > MAX_INPUT_LENGTH) {
          return {
            ok: false,
            error: `input "${input.name}" exceeds the ${MAX_INPUT_LENGTH}-character limit`,
          };
        }
        values[input.name] = source;
      }
    }
  }
  return { ok: true, values };
}

/**
 * Substitute resolved input values into a single argv element. Every `{{NAME}}`
 * is replaced with its (already validated) string value. Tokens are guaranteed
 * to reference declared inputs by config-load validation, so an unexpected
 * token here resolves to the empty string rather than leaking the literal.
 */
export function substituteArg(
  arg: string,
  values: Record<string, string>,
): string {
  return arg.replace(INPUT_TOKEN, (_, name: string) => values[name] ?? "");
}

/** Apply {@link substituteArg} to every arg of every step (commands untouched). */
export function substituteSteps(
  steps: readonly ActionStep[],
  values: Record<string, string>,
): ActionStep[] {
  return steps.map((step) => ({
    ...step,
    args: step.args.map((arg) => substituteArg(arg, values)),
  }));
}
