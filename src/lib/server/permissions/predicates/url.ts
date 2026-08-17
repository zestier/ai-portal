// Predicate for UrlScope grants — `url` permission requests.

import type { UrlScope } from "../../../permissions/scope-types";

export interface UrlMatchContext {
  url: string;
}

export function urlScopeMatches(
  scope: UrlScope,
  ctx: UrlMatchContext,
): boolean {
  const rule = scope.rule;
  switch (rule.kind) {
    case "exact":
      return ctx.url === rule.url;
    case "host": {
      const host = hostOf(ctx.url);
      // Normalize the stored rule host too, so legacy grants persisted
      // before store-time lowercasing (e.g. "GitHub.com") still match.
      return host !== null && host === rule.host.toLowerCase();
    }
    case "host-suffix": {
      const host = hostOf(ctx.url);
      if (host === null) return false;
      const suffix = rule.suffix.toLowerCase();
      return host === suffix || host.endsWith("." + suffix);
    }
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
