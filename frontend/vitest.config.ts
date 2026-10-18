import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	plugins: [svelte({ configFile: false })],
	resolve: {
		conditions: ['browser'],
		alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) }
	},
	test: {
		name: 'frontend',
		include: ['src/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
		environment: 'happy-dom'
	}
});
