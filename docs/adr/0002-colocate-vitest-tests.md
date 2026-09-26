# ADR-0002: Vitestのテストを対象ファイルの隣に配置する

- ステータス: 採用
- 決定日: 2026-09-26

## 背景

frontend・backend・docsと共有コードを継続的に検証したい。従来のNode.jsテストとブラウザシナリオはルートのtestsディレクトリに集まっており、実装の移動に追従しにくく、実行方法も分かれていた。

## 決定

- テストランナーをVitestに統一する。テストAPIは `vitest` から明示的にimportし、グローバルAPIは有効にしない。
- testsディレクトリを設けず、対象ファイルと同じディレクトリに `<名前>.test.ts` を配置する。例は `shared/protocol.ts` と `shared/protocol.test.ts`、`docs/index.html` と `docs/index.test.ts`。
- SvelteKitの予約ファイル `+page.svelte` は、ルーティングに干渉しない `page.test.ts` とする。複数モジュールを扱うテストは、主となる実装の隣に配置する。
- frontend・backend・docs・sharedを名前付きVitestプロジェクトとしてルート設定に登録する。Vitestと共通のテスト依存はルートのdevDependenciesで固定する。
- 通常テストはNode.js環境で動作させ、ネットワーク・時刻・ブラウザAPIなどの外部境界をモックする。モックとタイマーはテスト終了後に復元する。docsのHTML検証にはHappy DOMを使う。
- ブラウザや稼働中のサーバーが必要な検証は、対象の隣に `<名前>.e2e.test.ts` を置き、通常の実行から除外する。別設定と `test:e2e` タスクで明示的に実行する。
- 既存Playwrightシナリオは隣接する `.scenario.mjs`、ブラウザへ注入する補助コードは `.browser-fixture.js` に保持する。Vitestの `.e2e.test.ts` から独立したNode.jsプロセスで実行し、プロセス失敗・タイムアウトをテスト失敗として扱う。
- テストは実装からimportしない。テストにも既存の整形・型情報付きlint・関数の行数制限を適用する。CIでは通常テストを必須で実行する。

## 実行方法

ADR-0001に従い、入口はmiseとする。

```sh
mise run test
mise run //frontend:test
mise run //backend:test
mise run //docs:test
mise run test:shared
mise run test:watch
```

ブラウザ検証は、別ターミナルで `mise run dev` と `mise run //frontend:storybook` を起動してから実行する。

```sh
mise exec -- pnpm exec playwright install chromium
mise run test:e2e
```

必要に応じて `TEST_URL`（既定: http://localhost:5173）、`STORYBOOK_URL`（既定: http://127.0.0.1:6006）、`CHROME_PATH` を指定する。既存環境との互換用に `PLAYWRIGHT_MODULE` によるランタイム指定も維持する。ブラウザテストはサーバー起動とChromiumが必要なため、通常のCIテストには含めない。

## 検証範囲とトレードオフ

- frontendは写真の判定・転送・期限管理・探索状態・位置情報取得、backendは変換要求の認可・期限・上限とImagesへの引き渡し、sharedはプロトコル検証を扱う。
- docsはページ内リンク、IDの重複、ラベルの参照を検証する。見た目の完全な検証ではない。
- backendの通常テストはImagesなどをモックするため、Cloudflare実行環境自体の互換性は保証しない。起動済みWorkersに対するAPIシナリオを別途維持する。
- 実装とテストを同時に見つけ、移動・削除できる一方、ソースディレクトリのファイル数は増える。テストの本番バンドルへの混入を防ぐため、実装からの参照を禁止する。
- Node.js標準テストランナーの継続とtestsディレクトリへの集約も検討したが、プロジェクト単位の実行、watch、モックAPIを統一し、対象との対応を明確にするため採用しない。

## 参考となるOSS

- [Prometheusのutils.test.ts](https://github.com/prometheus/prometheus/blob/main/web/ui/mantine-ui/src/promql/utils.test.ts) はVitestを使用し、同じディレクトリの `utils.ts` を検証している。
- [Jaeger UIの開発方針](https://github.com/jaegertracing/jaeger-ui/blob/main/AGENTS.md) はVitestとテストの隣接配置を採用している。こちらの例は `Component.tsx` / `Component.test.js` で、拡張子は今回の方針と異なる。
- [Vitest: Test Projects](https://vitest.dev/guide/projects)
