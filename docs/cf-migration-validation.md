# Cloudflare cf 移行検証

2026年10月4日に、作業ツリーの一時コピーで `cf 1.0.0-beta.12` への移行を検証した。backend は設定と型参照の補完後にビルド、型検査、ローカル動作、deploy dry-run が成功した。frontend は現行 adapter が cf の Build Output を生成せず、移行を完了できなかった。本番設定と CI は Wrangler のまま維持する。

## 検証環境

- Node.js `24.20.0`、pnpm `10.34.5`、Wrangler `4.138.0`
- SvelteKit `2.70.3`、adapter-cloudflare `7.2.9`、Vite `8.3.1`
- 一時コピーの backend/frontend に `cf` と `wrangler` の依存宣言を追加し、検証用インストールを参照した。既存アプリの依存関係は維持した。
- `cf migrate <package>/wrangler.jsonc --dry-run` で変換内容を確認後、コピー上で `--no-install` により設定を生成した。実リポジトリの設定、lockfile、secret は変更していない。

## backend の結果

自動変換は `HUB` と `IMAGES` を保持したが、Durable Object binding の確認と `migrations` の置き換えを要求した。`NearbyHub` を SQLite の export として宣言して解消した。

さらに、生成された `worker: "pico-drop-backend"` という文字列参照では `HUB` が型引数なしの `DurableObjectNamespace` になり、写真アクセスに必要な `consumePhoto` / `revokePhoto` の RPC 型が失われた。`tsc --noEmit` は TS2739 で失敗した。entrypoint を文字列から import に変えるだけでは解消しなかったが、binding の `worker` に型付き Worker 設定を渡すと成功した。

検証で成功した設定の構造は次のとおり。TURN secret は値を登録せず、名前のみ宣言した。

```ts
import { bindings, defineConfig, exports } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

const hubWorker = {
	name: 'pico-drop-backend',
	compatibilityDate: '2026-09-24',
	entrypoint,
	exports: { NearbyHub: exports.durableObject({ storage: 'sqlite' }) }
};

export default defineConfig({
	worker: {
		...hubWorker,
		env: {
			HUB: bindings.durableObject({
				worker: hubWorker,
				exportName: 'NearbyHub'
			}),
			IMAGES: bindings.images({}),
			TURN_KEY_ID: bindings.secret(),
			TURN_KEY_API_TOKEN: bindings.secret()
		}
	}
});
```

Wrangler bundler の設定は生成された `wrangler.config.ts` を使用した。型生成後、backend の `tsconfig.json` の `types` を `./.cloudflare/types/index.d.ts` と `node` に変更し、`include` に `cloudflare.config.ts` と `.cloudflare/types/**/*.d.ts` を追加した。従来の `worker-configuration.d.ts` は検査対象から外した。

| 検証                             | 結果                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| `cf build`                       | 成功。`.cloudflare/output/v0/config.json` と Worker bundle を生成 |
| `cf workers types`               | 成功。`.cloudflare/types/index.d.ts` を生成                       |
| `pnpm exec tsc --noEmit`         | 型付き Worker 参照への補完後に成功                                |
| `cf deploy --dry-run`            | 成功。HUB / IMAGES を確認、アップロードなし                       |
| `cf deploy --prebuilt --dry-run` | 成功。ビルド済み成果物を使用、アップロードなし                    |
| `cf dev --port 18787`            | 起動成功                                                          |
| `/api/health`                    | 200、service が `pico-drop-backend`                               |
| Origin なしのセッション作成      | 403                                                               |
| Origin 付きのセッション作成      | 201、token と id を取得。Durable Object の保存処理が動作          |
| WebSocket 接続と auth            | 101、`ready` の device id が発行済みセッションと一致              |
| backend/shared の既存 Vitest     | 4 ファイル、25 テストすべて成功                                   |

型生成と開発サーバーはローカル待受が必要なため、sandbox 外で実行した。ビルド中には Docker socket への権限エラーも出たが、ビルドと dry-run は終了コード 0 で成功した。Containers は本アプリで使用していない。

TURN secret 未設定の警告は出る。TURN の任意利用を保つには、実際の移行時に secret 宣言を有効にする条件も設計する必要がある。Images 変換と TURN のリモート動作、本番への公開、既存の本番 Durable Object データの継続性は未検証である。

## frontend の結果

`cf migrate` は必須の手動修正なしで設定を生成した。BACKEND service binding、ASSETS、Worker 名、compatibility flag、workers.dev と preview URL の設定を保持した。assets directory は `wrangler.config.ts` に移された。

`svelte-kit sync` の後で `cf build` を実行すると、cf は `vite build` に処理を委譲した。SvelteKit の SSR/client ビルドと adapter の処理は成功し、`.svelte-kit/cloudflare` の成果物が生成された。しかし、最後に次のエラーで終了コード 1 となった。

```text
Build Output Specification: no root config found at
<frontend>/.cloudflare/output/v0/config.json.
```

現行 adapter の実装は Wrangler の `unstable_readConfig` / `getPlatformProxy` を使用する。従来の `wrangler.jsonc` を残した今回の検証でも cf の Build Output は生成されなかった。frontend の cf deploy dry-run は、このビルド失敗により実行対象となる成果物がなく未実施である。

したがって、現行構成で `wrangler deploy` を `cf deploy` に置換するだけの全面移行は採用できない。adapter の対応版を選ぶか、SvelteKit 成果物を cf の Build Output に接続するビルド工程が必要で、その方式は今回未検証である。

## 推奨する次の変更

backend の先行移行は技術的に可能。ただし本番の Durable Object データ維持と Images/TURN を確認してから公開する。Wrangler bundler を使うため、cf を導入しても Wrangler 依存は残る。

frontend は現行 Wrangler を維持する。対応するビルド方式が確認できてから、backend → frontend の公開順を保持して CI を移行する。cf の CI 認証には既存の `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を利用でき、ビルド成果物の公開には `cf deploy --prebuilt` を使う。

## 公式資料

- [Wrangler プロジェクトの移行](https://developers.cloudflare.com/cf/wrangler/migrate/)
- [cf のビルドと deploy](https://developers.cloudflare.com/cf/projects/)
- [Wrangler との対応と未対応コマンド](https://developers.cloudflare.com/cf/wrangler/reference/)
- [CI での利用](https://developers.cloudflare.com/cf/ci/)

cf はベータ版であり、この結果は上記バージョンの現行アプリに対するもの。通常インストールでの lockfile 更新や、将来の adapter の対応を確認した結果ではない。
