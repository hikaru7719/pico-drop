import type { StorybookConfig } from '@storybook/sveltekit';

const config: StorybookConfig = {
	stories: ['../src/**/*.stories.ts'],
	addons: ['@storybook/addon-docs'],
	framework: '@storybook/sveltekit',
	core: { disableTelemetry: true }
};
export default config;
