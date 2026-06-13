import { installCsrfFetch } from '$lib/client/csrf';

// Install the CSRF fetch interceptor once at client startup so every mutating
// same-origin request carries the X-CSRF-Token header (see
// src/lib/client/csrf.ts).
installCsrfFetch();
