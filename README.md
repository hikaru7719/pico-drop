# pico-drop

Share photos with a link.

短期間の共有リンクで、ブラウザから写真を渡すサービス。Bunは不要です。

## 構成

```text
frontend/  SvelteKit / TypeScript / Cloudflare Workers
backend/   TypeScript / Cloudflare Workers / Durable Objects
docs/      設計方針・開発メモ
```

frontend・backend・docsはpnpmワークスペースの独立したパッケージです。共通設定とlockfileをルートで管理します。

依存パッケージはexactバージョンで指定し、`.npmrc` の `save-exact=true` により `pnpm add` でも固定します。更新時はpackage.jsonとlockfileをあわせて更新してください。

バックエンドはTypeScript 7.0.2のGo製コンパイラ（旧称tsgo）を使用します。正式版のコマンド名は `tsc` です。フロントエンドは `@typescript/native` エイリアスでTypeScript 7.0.2を併用し、通常・watchともに `svelte-check --tsgo` で型検査します。SvelteKitとSvelte関連ツールの内部処理用に `typescript` は6.0.3を維持します。

## セットアップ

miseをインストール済みの環境で実行します。Node.js・pnpm・Wrangler・oxfmt・oxlintは `mise.toml` に固定し、miseでインストールします。SvelteKit・TypeScriptなどプロジェクトの依存パッケージはpnpmで管理します。

```sh
mise trust
mise run setup
mise run dev
```

通常はフロントエンドが http://localhost:5173 、バックエンドが http://localhost:8787 で起動します。タスクは `mise run` で実行します。シェルへのmiseの有効化は不要です。

```sh
mise run //frontend:dev
mise run //backend:dev
mise run check
mise run test
mise run lint
mise run format:check
mise run build
mise run //frontend:preview
```

`mise run setup` は依存のインストール、Workers型の生成、SvelteKitの同期を順に実行します。依存更新のために `mise exec -- pnpm install` を直接実行した場合は、`mise run //frontend:sync` でSvelteKitを同期してください。

タスク一覧は `mise tasks ls --all` で確認できます。ルートのタスクはルートディレクトリで実行します。他のディレクトリからルートのlintを実行する場合は `mise run //:lint` のように指定します。

Wrangler設定変更後は `mise run gen` で型を再生成します。整形は `mise run format`。

整形設定は `.oxfmtrc.json`、lint設定は `.oxlintrc.json` で管理します。整形はリポジトリ全体（`shared/` を含む）が対象です。lintは `frontend/`・`backend/`・`shared/`・`docs/` が対象です。生成ファイル・ビルド出力・作業用ディレクトリは対象外にしています。設定のJSON Schemaはmiseで固定したバージョンを参照するため、ツール更新時にあわせて更新してください。

関数間は空行を1行入れて記述します。oxfmtは既存の空行を保持しますが、関数間に空行を自動挿入する設定はありません。`printWidth: 80` は長い行の折り返しの目安であり、文字列などを含むすべての行の長さを強制する上限ではありません。`singleAttributePerLine: true` で複数属性を持つ要素を1属性1行にし、`objectWrap: "preserve"` で既存のオブジェクトの改行を保持します。型定義も複数行で記述し、整形後も改行を維持します。Svelteの整形にはルートの `svelte` 依存と、formatタスクの `NODE_PATH` を使用します。

## 現在の実装範囲

匿名セッション、10分間有効な共有リンク、受信承諾、WebRTCによる複数枚転送、進捗・キャンセル・プレビュー・共有保存を実装しています。1回10枚・合計50MBまで。写真をサーバーに保存しません。受信写真は受信完了から10分、破棄、ページ離脱のいずれかでブラウザ内の参照を解放します。HEIC/HEIFは、利用者の操作でCloudflare Imagesへ送ってプレビュー・JPEG変換できます。原本は変更しません。

送信側で写真を選んで「共有リンクを作成する」を押し、LINEなどで相手1人に送ってください。受信側はリンクを開くと相手の名前・写真の枚数・容量が表示され、「受け取る」を押すと転送します。リンクは受信画面の読み込み時点で使用済みになります。双方とも画面を開いたままにしてください。リンクは作成から10分間、最初の参加だけに有効です。取り消し・送信者の切断でも失効します。参加済みの転送はリンク期限から独立して継続します。合言葉・位置情報は使いません。受け取った写真は、共有シートまたは個別ダウンロードから保存できます。

TURN未設定時はSTUNと直接接続のみです。iPhone Safari実機、異なる回線、TURN強制接続、実際のHEIC/HEIF保存は未検証です。暫定値・テスト・公開前の確認項目は [MVP実装メモ](docs/mvp.md) を参照してください。

仕様は `docs/pico-drop-design.md`、実装順序は `docs/development.md` を参照してください。

## 写真の期限とHEIC変換

Workersの `IMAGES` bindingを使い、画像の保存・公開URL発行は行わず変換結果を返します。バックエンドのデプロイ先アカウントでImagesの変換機能を利用可能にしてください。変換は利用料金の対象です。R2・Imagesのホスト画像ストレージは不要です。ローカル環境ではImagesのエミュレーションの対応形式に差があるため、実際のHEIC変換はCloudflare上でも検証してください。

原本転送は従来どおり10枚・合計50MiB、変換は1枚20MiBまでです。詳しくは[写真処理の設計](docs/photos.md)を参照してください。

## 公開

```sh
mise exec -- wrangler login
mise run //backend:deploy
mise run //frontend:deploy
```

公開する段階で実行してください。`mise run build` はフロントエンド・資料のビルドとバックエンドのdry-runを行い、リモートに公開しません。

frontendは `BACKEND` service bindingでbackendへ同一オリジンの `/api/*` を転送します。backendを先にデプロイしてください。開発時はViteのHTTP/WebSocket proxyを利用します。

TURNを有効にする場合は、backendディレクトリで `mise exec -- wrangler secret put TURN_KEY_ID` と `mise exec -- wrangler secret put TURN_KEY_API_TOKEN` を実行します。管理鍵はブラウザに渡しません。ローカルでは `backend/.dev.vars` に同名の値を設定できます。このファイルはGit管理しません。

参考: [SvelteKit Cloudflare adapter](https://svelte.dev/docs/kit/adapter-cloudflare)、[mise](https://mise.jdx.dev/configuration.html)、[pnpm workspace](https://pnpm.io/workspaces)

## GitHub Actions

- `.github/workflows/build.yml`: PR・mainへのpush・手動実行で、セットアップとfrontend・backend・docsのビルドを実行します。
- `.github/workflows/deploy.yml`: mainへのpush・mainを選択した手動実行で、同じセットアップとビルドを実行後、backend→frontendの順にCloudflare Workersへ公開します。docsは公開対象に含みません。

GitHubのSettings → Environmentsで `production` を作成し、次のEnvironment secretsを登録してください。

- `CLOUDFLARE_API_TOKEN`: 対象アカウントのWorkersをデプロイできるAPIトークン。
- `CLOUDFLARE_ACCOUNT_ID`: デプロイ先のCloudflareアカウントID。

mainへpushすると自動で公開します。Actions → Deploy → Run workflowで `main` を選んで手動で公開することもできます。他のブランチではデプロイジョブをスキップします。同時デプロイは直列化し、実行中のデプロイはキャンセルしません。

ツールは既存の `mise.toml`、依存はlockfileを使います。すべての `uses` は40桁のコミットSHAで固定しています。アクション更新時は公式リポジトリでタグに対応するSHAを確認し、両ワークフローのSHAとバージョンコメントをあわせて更新してください。

## アーキテクチャ資料

`docs/index.html` に現在のアーキテクチャをまとめています。

```sh
mise run //docs:dev
```

http://127.0.0.1:5174 で閲覧できます。`mise run dev` はアプリ用で、資料サーバーは別途起動します。HTML・CSSの変更は自動反映されます。

`mise run //docs:build` で `docs/dist/` に静的ファイルを生成し、`mise run //docs:preview` で http://127.0.0.1:4174 からビルド結果を確認できます。

## 意思決定の記録

- [ADR-0001: タスク実行をmiseに集約する](docs/adr/0001-use-mise-for-task-execution.md)

## Storybook

`mise run //frontend:storybook` で起動し、http://127.0.0.1:6006/ を開きます。
`mise run //frontend:build-storybook` で `frontend/storybook-static/` に静的出力します。

「画面 / 写真を共有」から写真選択、リンク作成、リンク共有、参加、受信承諾、転送、受信完了、エラーなど17状態を確認できます。
「コンポーネント / 探索の波紋」ではアニメーション単体を確認できます。

本番と共通の `DropView.svelte` を固定データで表示します。バックエンド、WebRTCは不要です。
ボタンはStorybookのアクション記録用で、実際の通信や画面遷移は実行しません。状態の切り替えはサイドバーから行ってください。
新しい画面状態は `DropView.stories.ts` に追加します。

## テスト

Vitestのテストは対象ファイルの隣に `.test.ts` として配置します。testsディレクトリは設けません。`mise run test` でfrontend・backend・docs・sharedを検証し、`mise run //frontend:test`、`mise run //backend:test`、`mise run //docs:test`、`mise run test:shared` で個別実行できます。watchは `mise run test:watch`、起動済みアプリとStorybookのブラウザ検証は `mise run test:e2e` です。

- [ADR-0002: Vitestのテストを対象ファイルの隣に配置する](docs/adr/0002-colocate-vitest-tests.md)

## React Routerとの性能比較

`benchmarks/react-router/` にReact RouterのSSR比較アプリ、`benchmarks/sveltekit/` に同じ機能のSvelteKit比較アプリを用意しています。`mise run bench` で本番ビルドをChromiumで計測できます。導入範囲・計測条件・限界は [比較手順](benchmarks/README.md)、測定結果は [性能比較レポート](benchmarks/report.md) を参照してください。
