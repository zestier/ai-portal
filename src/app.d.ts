// See https://kit.svelte.dev/docs/types#app
declare global {
  namespace App {
    interface Locals {
      // Single shared local user, always logged in — the app ships no auth
      // layer, so `userId` is never null (see hooks.server.ts).
      userId: number;
      user: import("$lib/types").User | null;
      csrfToken: string;
    }
    interface PageData {
      user: import("$lib/types").User | null;
    }
    interface Error {
      message: string;
      code?: string;
      /** Structured, code-specific context (e.g. a worktree's ahead count). */
      detail?: unknown;
    }
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
