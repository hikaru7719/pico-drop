import type { Meta, StoryObj } from '@storybook/sveltekit';
import { PASSPHRASES } from '../../../../shared/protocol';
import { fn } from 'storybook/test';
import DropView from './DropView.svelte';
import brandIcon from '$lib/assets/pico-drop-icon.png';

const me = { id: 'me', name: 'あなたの端末', token: 'storybook-only', expiresAt: 0 };
const friend = { id: 'friend', name: 'ゲスト A24B' };
const file = new File(['storybook photo'], 'weekend.png', { type: 'image/png' });
const files = [{ id: 'photo-1', name: file.name, type: file.type, size: file.size }];
const request = {
	type: 'requested' as const,
	id: 'request-1',
	from: me,
	to: friend,
	files,
	confirmation: { kind: 'tell' as const, word: 'さくら' }
};
const meta = {
	title: '画面/写真を共有',
	component: DropView,
	parameters: { layout: 'fullscreen' },
	args: {
		connection: 'online',
		session: me,
		connect: fn(),
		startDiscovery: fn(),
		stopDiscovery: fn(),
		chooseRecipient: fn(),
		select: fn(),
		invite: fn(),
		action: fn(),
		save: fn(),
		discard: fn()
	}
} satisfies Meta<typeof DropView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Initial: Story = {
	name: '01 探索前',
	args: { connection: 'idle', session: undefined }
};
export const Connecting: Story = {
	name: '02 接続中',
	args: { connection: 'connecting', session: undefined }
};
export const Locating: Story = { name: '03 位置情報を取得中', args: { searching: true } };
export const Searching: Story = { name: '04 近くの人を探索中', args: { discovering: true } };
export const Nearby: Story = {
	name: '05 相手を選ぶ',
	args: { discovering: true, devices: [friend, { id: 'second', name: 'ゲスト C56D' }] }
};
export const ChoosePhotos: Story = {
	name: '06 写真を選ぶ',
	args: { recipient: friend, devices: [friend] }
};
export const PhotosSelected: Story = {
	name: '07 写真を選択済み',
	args: { recipient: friend, devices: [friend], selected: [file], metadata: files }
};
export const RecipientUnavailable: Story = {
	name: '08 相手が見つからない',
	args: { recipient: friend, selected: [file], metadata: files }
};
export const SendingRequest: Story = { name: '09 相手の承諾待ち', args: { request } };
export const IncomingRequest: Story = {
	name: '10 受信の承諾',
	args: {
		request: {
			...request,
			from: friend,
			to: me,
			confirmation: { kind: 'choose', options: [...PASSPHRASES] }
		}
	}
};
export const ConfirmCode: Story = {
	name: '11 あいことばを伝える',
	args: { request, phase: 'confirm' }
};
export const WaitingConfirmation: Story = {
	name: '12 あいことばを選ぶ',
	args: {
		request: {
			...request,
			from: friend,
			to: me,
			confirmation: { kind: 'choose', options: [...PASSPHRASES] }
		},
		phase: 'confirm'
	}
};
export const PeerConnecting: Story = {
	name: '13 転送の接続中',
	args: { request, phase: 'connecting' }
};
export const Transferring: Story = {
	name: '14 写真を転送中',
	args: { request, phase: 'transferring', bytes: 7 }
};
export const Verifying: Story = {
	name: '15 データを検証中',
	args: { request, phase: 'transferring', bytes: file.size }
};
export const Sent: Story = {
	name: '16 送信完了',
	args: { completed: true, notice: '相手の端末で、すべての写真の受信とデータ一致を確認しました。' }
};
export const Received: Story = {
	name: '17 受信完了',
	args: {
		completed: true,
		received: [{ file, url: brandIcon, preview: true }],
		notice: '写真を受け取りました。保存するには、下のボタンを押してください。'
	}
};
export const UnsupportedPreview: Story = {
	name: '18 プレビュー非対応',
	args: {
		completed: true,
		received: [
			{
				file: new File(['sample'], 'photo.heic', { type: 'image/heic' }),
				url: brandIcon,
				preview: false
			}
		]
	}
};
export const LocationDenied: Story = {
	name: '19 位置情報が未許可',
	args: {
		flowStarted: true,
		locationMessage: '位置情報が許可されていません。ブラウザの設定で許可して再試行してください。'
	}
};
export const Offline: Story = {
	name: '20 接続エラー',
	args: { connection: 'offline', error: '接続が切れました。再接続して相手を探してください。' }
};
