import { defineConfig } from 'vitest/config';

const projects = ['backend', 'docs', 'shared'];
export default defineConfig({
	test: {
		coverage: {
			provider: 'v8',
			thresholds: {
				lines: 90,
				statements: 90,
				functions: 90,
				branches: 90
			}
		},
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
