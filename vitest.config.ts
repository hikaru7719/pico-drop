import { defineConfig } from 'vitest/config';

const projects = ['backend', 'docs', 'shared'];
export default defineConfig({
	test: {
		projects: [
			'./frontend/vitest.config.ts',
			...projects.map((name) => ({
				test: {
					name,
					include: [`${name}/**/*.test.ts`],
					exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
					environment: 'node'
				}
			}))
		]
	}
});
