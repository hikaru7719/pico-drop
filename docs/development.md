# 開発メモ

## 初期構成

- `frontend/`: 公式Svelte CLIのminimalテンプレートを基にTypeScriptとCloudflare adapterを設定。SvelteKit設定は `vite.config.ts` に置く。
- `backend/`: Workersの独立したエントリーポイント。匿名session API、Nearby、WebSocket signaling、TURN資格情報発行を提供。
- `docs/`: 設計・開発ドキュメント。
- ルート: pnpmワークスペース、共通の整形設定、lockfile、miseのツール設定。

Node.js・pnpm・Wrangler・oxfmt・oxlintはmiseで管理する。開発・ビルド・検査・公開のタスクはルートと各パッケージの `mise.toml` に定義する。`package.json` のscriptsは使用しない。SvelteKit adapterが内部依存として持つWranglerはパッケージ側で管理されるが、直接使うCLIはmiseの固定バージョンを使用する。

## MVP実装

匿名セッション、DO WebSocket Hibernation、Nearby、受信承諾・あいことば、複数枚転送、保存UIを実装済み。通信の型・検証は `shared/protocol.ts`、ブラウザの通信は `frontend/src/lib/webrtc/` に分離しています。

詳細な暫定値、実行方法と未検証事項は [MVP実装メモ](mvp.md) を参照してください。写真本体はDataChannelのみで転送し、座標は期限付きのWebSocket attachmentだけに保持します。

## 検証

初期構成は型チェック・整形・ビルド・ローカルHTTP応答で確認する。転送実装時は状態遷移と承諾前の送信防止をテストする。

iPhone実機ではHTTPS接続を使う。LAN上のHTTPだけではGeolocationやWeb Share等の確認条件を満たさない。最低対応iOS版や容量上限は実機確認後に決める。

## 静的解析と整形

`mise run lint` はoxlint、`mise run format` / `mise run format:check` はoxfmtをmise経由で実行する。生成物・依存パッケージは対象外。Svelte整形はoxfmtのSvelte対応を有効にし、その実行に必要なSvelteコンパイラをルートの開発依存に置く。独立したPrettier設定は使用しない。Svelte固有の診断は `mise run check` のsvelte-checkで補完する。

フロントエンドのソースはTypeScriptに統一し、生成されたWorkerのJavaScriptが型チェックに混入しないようallowJs/checkJsを無効にする。

グローバル配置のoxfmtがワークスペースのSvelteコンパイラを解決できるよう、整形スクリプトはNODE_PATHをルートのnode_modulesに指定する。miseのnpmツールは標準npm方式でインストールする設定に統一する（アプリの依存管理はpnpmのまま）。

## タスク管理

[ADR-0001](adr/0001-use-mise-for-task-execution.md) に従い、タスクはmise、依存管理はpnpmに集約する。`mise run setup` で依存インストール・Workers型生成・SvelteKit同期を行う。`mise run dev` はfrontendとbackendを並列起動し、資料は `mise run //docs:dev` で別途起動する。`mise tasks ls --all` で全タスクを確認できる。
