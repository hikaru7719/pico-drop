import type { Meta, StoryObj } from '@storybook/sveltekit';
import DiscoveryPulse from './DiscoveryPulse.svelte';

const meta = {
	title: 'コンポーネント/探索の波紋',
	component: DiscoveryPulse,
	parameters: { layout: 'centered' },
	args: { locating: false }
} satisfies Meta<typeof DiscoveryPulse>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Searching: Story = { name: '探索中' };
export const Locating: Story = {
	name: '現在地を確認中',
	args: { locating: true }
};
