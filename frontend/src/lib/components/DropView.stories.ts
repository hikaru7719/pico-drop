import type { Meta, StoryObj } from '@storybook/sveltekit';
import { fn } from 'storybook/test';
import DropView from './DropView.svelte';
import brandIcon from '$lib/assets/pico-drop-icon.png';

const me = {
	id: 'me',
	name: 'あなたの端末',
	token: 'storybook-only',
	expiresAt: 0
};
const friend = { id: 'friend', name: 'ゲスト A24B' };
const file = new File(['storybook photo'], 'weekend.png', {
	type: 'image/png'
});
const files = [
	{ id: 'photo-1', name: file.name, type: file.type, size: file.size }
];
const request = {
	type: 'requested' as const,
	id: 'request-1',
	from: me,
	to: friend,
	files
};
const meta = {
	title: '画面/写真を共有',
	component: DropView,
	parameters: { layout: 'fullscreen' },
	args: {
		senderAuthenticated: true,
		connection: 'online',
		session: me,
		connect: fn(),
		createLink: fn(),
		revokeLink: fn(),
		shareInvitation: fn(),
		copyInvitation: fn(),
		select: fn(),
		action: fn(),
		save: fn(),
		discard: fn()
	}
} satisfies Meta<typeof DropView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Initial: Story = {
	name: '01 写真選択前',
	args: { connection: 'idle', session: undefined }
};
export const Connecting: Story = {
	name: '02 接続中',
	args: { connection: 'connecting', session: undefined }
};
export const CreatingLink: Story = {
	name: '03 QRを準備中',
	args: { creatingLink: true, selected: [file], metadata: files }
};
export const LinkReady: Story = {
	name: '04 QRを見せて待機',
	args: {
		shareLink: 'https://example.com/#share=' + 'a'.repeat(64),
		linkExpiresAt: Date.now() + 600_000
	}
};
export const JoinLink: Story = {
	name: '05 共有内容を確認中',
	args: {
		senderAuthenticated: false,
		incomingToken: 'a'.repeat(64),
		connection: 'connecting'
	}
};
export const ChoosePhotos: Story = {
	name: '06 写真を選ぶ',
	args: { flowStarted: true }
};
export const PhotosSelected: Story = {
	name: '07 写真を選択済み',
	args: { selected: [file], metadata: files }
};
export const LinkExpired: Story = {
	name: '08 リンク期限切れ',
	args: {
		flowStarted: true,
		error: '共有リンクの有効期限が切れました。新しく作成してください。'
	}
};
export const SendingRequest: Story = {
	name: '09 相手の承諾待ち',
	args: { request }
};
export const IncomingRequest: Story = {
	name: '10 受信の承諾',
	args: {
		senderAuthenticated: false,
		request: {
			...request,
			from: friend,
			to: me
		}
	}
};
export const PeerConnecting: Story = {
	name: '11 転送の接続中',
	args: { request, phase: 'connecting' }
};
export const Transferring: Story = {
	name: '12 写真を転送中',
	args: { request, phase: 'transferring', bytes: 7 }
};
export const Verifying: Story = {
	name: '13 データを検証中',
	args: { request, phase: 'transferring', bytes: file.size }
};
export const Sent: Story = {
	name: '14 送信完了',
	args: {
		completed: true,
		notice:
			'すべての写真が相手の端末に届きました。元の写真と同じデータであることも確認できました。'
	}
};
export const Received: Story = {
	name: '15 受信完了',
	args: {
		completed: true,
		received: [{ file, url: brandIcon, preview: true }],
		notice: '写真を受け取りました。保存するには、下のボタンを押してください。'
	}
};
export const UnsupportedPreview: Story = {
	name: '16 プレビュー非対応',
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
export const Offline: Story = {
	name: '18 接続エラー',
	args: {
		connection: 'offline',
		error: '接続が切れました。新しい共有リンクで再試行してください。'
	}
};
