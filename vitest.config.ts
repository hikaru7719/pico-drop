import { defineConfig } from 'vitest/config';

const projects = ['frontend', 'backend', 'docs', 'shared'];
export default defineConfig({
	test: {
		projects: projects.map((name) => ({
			test: {
				name,
				include: [`${name}/**/*.test.ts`],
				exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
				environment: 'node'
			}
		}))
	}
});
