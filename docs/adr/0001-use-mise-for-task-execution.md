# ADR-0001: タスク実行をmiseに集約する

- ステータス: 採用
- 決定日: 2026-09-24

## 背景

このリポジトリはfrontend・backend・docsをpnpmワークスペースとして管理している。これまでは各 `package.json` のscriptsでタスクを定義し、ルートのscriptsからpnpmの再帰実行やfilterで呼び出していた。一方、Node.js・pnpm・Wrangler・oxfmt・oxlintのバージョンはmiseで管理しており、scriptsからさらにmiseを呼ぶ構成になっていた。

実行コマンド、作業ディレクトリ、依存するタスク、ツールのバージョンをmiseにまとめ、タスク定義と実行入口を統一したい。

## 決定

1. 開発・型生成・型チェック・ビルド・テスト・lint・整形・公開のタスクはmiseに定義する。プロジェクトの `package.json` にscriptsは定義しない。
2. ルートの `mise.toml` にツールのバージョン、共通タスク、集約タスクを置く。frontend・backend・docsの `mise.toml` に、それぞれのディレクトリで実行するタスクを置く。
3. `monorepo_root = true` と `[monorepo].config_roots` でタスクの探索対象を明示する。タスク間の依存と並列実行はmiseの `depends`、順次処理は `run` の配列で表現する。
4. pnpmは引き続き依存パッケージ、lockfile、ワークスペース内の依存関係を管理する。`pnpm-workspace.yaml` と各 `package.json` は維持する。ローカル依存のCLIを解決する用途の `pnpm exec` は使用するが、`pnpm run` やpackage scriptsによるタスク管理は使用しない。
5. mise管理のWrangler・oxfmt・oxlintはタスクから直接実行する。Vite・SvelteKit・svelte-check・TypeScriptは各パッケージの依存を `pnpm exec` で実行する。
6. `prepare` によるSvelteKit同期は廃止し、`mise run setup` で依存インストール、Workers型生成、SvelteKit同期を順に実行する。frontendのdev・check・check:watch・buildもsyncタスクに依存させる。
7. ワークスペース依存グラフの自動推論やpackage scriptsの自動取り込みといった実験的機能には依存しない。

## 利用方法

ルートディレクトリで実行する。

```sh
mise trust
mise run setup
mise run dev
mise run check
mise run test
mise run lint
mise run format:check
mise run build
```

個別のタスクは `mise run //frontend:dev`、`mise run //backend:check`、`mise run //docs:build` のように呼ぶ。全タスクは `mise tasks ls --all` で確認できる。ルートタスクを別ディレクトリから呼ぶ場合は `mise run //:lint` のようにルートを明示する。

`build` はローカルビルドとWorkersのdry-runを実行する。公開は `//frontend:deploy` と `//backend:deploy` を明示的に実行する。

## 結果とトレードオフ

- ツールのバージョンとタスクを同じ仕組みで管理でき、タスク内の `mise exec` の重複がなくなる。
- タスクの実行順序と並列性をmiseに集約できる。アプリの同時起動もpnpmのparallel実行に依存しない。
- pnpmの依存管理は継続できるが、日常の実行コマンドは `pnpm <script>` から `mise run <task>` に変わる。READMEと今後のCIはmiseのタスクを利用する。
- `pnpm install` 単体ではSvelteKitの同期を行わない。初回は `mise run setup` を使用し、依存更新後に手動で同期する場合は `mise run //frontend:sync` を実行する。
- 新しいパッケージを追加するときはpnpmワークスペースの登録に加えて、miseの `config_roots` と必要な集約タスクも更新する。
- モノレポタスク機能を備えたmiseを必要とする。移行時の確認対象はmise 2026.8.10とする。

## 検討した代替案

- **package scriptsを維持する:** npmエコシステムでは一般的だが、タスク管理とツール管理の定義が分かれたままになる。
- **ルートのmise.tomlに全タスクを定義する:** 作業ディレクトリを個別指定すれば実現できるが、パッケージ固有の定義は各ディレクトリに置く方が変更を追いやすい。
- **miseによるpackage scriptsの自動取り込み:** scriptsへの依存が残るため採用しない。

## 参考

- [mise: Monorepo Tasks](https://mise.jdx.dev/tasks/monorepo.html)
- [mise: Task Configuration](https://mise.jdx.dev/tasks/task-configuration.html)
