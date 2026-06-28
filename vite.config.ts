import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}', 'tests/**/*.{test,spec}.{js,ts}'],
		environment: 'node',
		setupFiles: ['tests/setup.ts'],
		// Fork per file so module-level caches (config singleton, sqlite
		// handle, mocked modules) don't leak across files.
		pool: 'forks',
		isolate: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			include: ['src/lib/**/*.{ts,js}', 'src/routes/**/*.{ts,js}'],
			exclude: [
				'src/lib/**/*.test.{ts,js}',
				'src/lib/**/*.spec.{ts,js}',
				'src/routes/**/*.test.{ts,js}',
				'src/routes/**/*.spec.{ts,js}',
				'src/routes/**/+page*.svelte',
				'src/routes/**/+layout*.svelte',
				'src/routes/**/$types.{ts,js}',
				'src/**/*.d.ts'
			]
		}
	},
	server: {
		port: 5173,
		strictPort: false
	},
	ssr: {
		// better-sqlite3 is native; never bundle it.
		external: ['better-sqlite3']
	}
});
