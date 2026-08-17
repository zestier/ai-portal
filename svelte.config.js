import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ out: "build" }),
    // CSP for HTML responses. Hash mode lets SvelteKit emit integrity
    // hashes for the inline hydration <script> blocks it generates,
    // so we can drop `'unsafe-inline'` from script-src. The matching
    // header for non-HTML responses (API JSON, SSE, etc.) is set in
    // src/hooks.server.ts; both must stay in sync.
    csp: {
      mode: "hash",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "connect-src": ["self"],
        "img-src": ["self", "data:", "https://avatars.githubusercontent.com"],
        "font-src": ["self", "data:"],
        "frame-ancestors": ["none"],
        "base-uri": ["self"],
        "form-action": ["self"],
      },
    },
    alias: {
      $lib: "src/lib",
    },
  },
};

export default config;
