// CSRF double-submit token (client side).
//
// The server pins the token in an httpOnly cookie and renders the same value
// into the <meta name="csrf-token"> tag (see hooks.server.ts). For mutating
// requests the browser must echo the token back in the X-CSRF-Token header so
// the server can compare header-vs-cookie. Safe methods (GET/HEAD/...) are
// exempt — they must not mutate state, and this also leaves SvelteKit's own
// data-load fetches untouched.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

export function csrfToken(): string {
  if (typeof document === "undefined") return "";
  const m = document.querySelector('meta[name="csrf-token"]');
  return m?.getAttribute("content") ?? "";
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const m = init?.method ?? (input instanceof Request ? input.method : "GET");
  return m.toUpperCase();
}

function isSameOrigin(input: RequestInfo | URL): boolean {
  try {
    const href = input instanceof Request ? input.url : input.toString();
    return new URL(href, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

let installed = false;

// Patch the global fetch once so every mutating same-origin request carries
// the CSRF token. Wiring it here — rather than at each of the ~30 call sites —
// keeps the protection complete and resilient to future call sites.
export function installCsrfFetch(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!SAFE_METHODS.has(requestMethod(input, init)) && isSameOrigin(input)) {
      const token = csrfToken();
      if (token) {
        const headers = new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        );
        if (!headers.has("x-csrf-token")) {
          headers.set("x-csrf-token", token);
          init = { ...init, headers };
        }
      }
    }
    return original(input, init);
  };
}
