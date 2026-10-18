import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
	plugins: [svelte({ configFile: false })],
	resolve: {
		conditions: ['browser']
	},
	test: {
		name: 'frontend',
		include: ['src/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
		environment: 'happy-dom'
	}
});
