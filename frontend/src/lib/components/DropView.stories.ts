import type { Meta, StoryObj } from '@storybook/sveltekit';
import { fn } from 'storybook/test';
import DropView from './DropView.svelte';
import brandIcon from '#lib/assets/pico-drop-icon.png?inline';

const me = {
	id: 'me',
	name: 'あなたの端末',
	token: 'storybook-only',
	expiresAt: 0
};
const friend = { id: 'friend', name: 'ゲスト A24B' };
const photoBytes = Uint8Array.from(atob(brandIcon.split(',')[1]!), (c) => c.charCodeAt(0));
const file = new File([photoBytes], 'weekend.png', {
	type: 'image/png'
});
const files = [{ id: 'photo-1', name: file.name, type: file.type, size: file.size }];
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
		addPhotos: fn(),
		restartSharing: fn(),
		action: fn(),
		removePhoto: fn(),
		convertPhoto: fn(),
		shareJpeg: fn(),
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
		selected: [file],
		metadata: files,
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
	args: { request, selected: [file] }
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
	args: { request, selected: [file], phase: 'connecting' }
};
export const Transferring: Story = {
	name: '12 写真を転送中',
	args: { request, selected: [file], phase: 'transferring', bytes: 7 }
};
export const Verifying: Story = {
	name: '13 データを検証中',
	args: { request, selected: [file], phase: 'transferring', bytes: file.size }
};
export const Sent: Story = {
	name: '14 送信完了',
	args: {
		selected: [file],
		metadata: files,
		completed: true,
		connection: 'idle'
	}
};
export const Received: Story = {
	name: '15 受信完了',
	args: {
		photosExpireAt: Date.now() + 600_000,
		completed: true,
		received: [{ file, url: brandIcon, preview: true }],
		connection: 'idle'
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

export const ManyPhotos: Story = {
	name: '19 10枚の写真を共有',
	args: {
		...LinkReady.args,
		selected: Array.from(
			{ length: 10 },
			(_, index) =>
				new File([photoBytes], `旅行の写真-${index + 1}-長いファイル名.png`, {
					type: 'image/png'
				})
		)
	}
};
export const ConvertedPhoto: Story = {
	name: '20 JPEGに変換済み',
	args: {
		completed: true,
		received: [
			{
				file: new File(['sample'], 'photo.heic', { type: 'image/heic' }),
				url: brandIcon,
				preview: true,
				previewUrl: brandIcon,
				jpeg: new File(['sample'], 'photo.jpg', { type: 'image/jpeg' }),
				jpegUrl: brandIcon
			}
		]
	}
};

export const Discarded: Story = {
	name: '21 写真を削除済み',
	args: {
		incomingToken: 'a'.repeat(64),
		invitationUsed: true,
		connection: 'idle',
		notice: '画面内の写真を削除しました。端末に保存した写真は残っています。'
	}
};
export const ReceivedExpired: Story = {
	name: '22 保存期限切れ',
	args: {
		...Discarded.args,
		notice: '受信から10分たったため、画面内の写真を削除しました。端末に保存した写真は残っています。'
	}
};
export const ManyReceived: Story = {
	name: '23 10枚の写真を受信',
	args: {
		...Received.args,
		received: ManyPhotos.args!.selected!.map((photo) => ({
			file: photo,
			url: brandIcon,
			preview: true
		}))
	}
};
