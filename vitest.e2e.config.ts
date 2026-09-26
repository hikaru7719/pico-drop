import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['frontend/**/*.e2e.test.ts', 'backend/**/*.e2e.test.ts'],
		fileParallelism: false,
		testTimeout: 120_000
	}
});
