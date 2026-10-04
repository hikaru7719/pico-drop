# React Router / SvelteKit 性能比較

React Router 8.4.0（Framework Mode / SSR）を比較用ワークスペースに導入し、既存frontendと同じSvelteKit 2.70.3 / Svelte 5.57.1と比較します。既存アプリの移行ではありません。

両方に同一のCSS、10枚の写真メタデータ一覧、選択ボタン、進捗更新、説明ページへのクライアント遷移を実装しています。SSRを揃えるためNode.jsの本番サーバーを使用します。SvelteKitはadapter-node、React Routerはreact-router-serveです。

```sh
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm exec playwright install chromium
mise run bench:check
mise run bench
```

`mise run bench` はビルド後にlocalhost:4311/4312を起動し、終了時に停止します。空いているポートで実行してください。`benchmarks/results/latest.json` に環境、中央値・p95・最小・最大、全サンプルを保存します。再実行で上書きします。計測中は別のビルドやテストを実行しないでください。回数は `BENCH_RUNS=30 mise run bench` で変更できます（最低5回）。

- local: CPU制限なし、追加回線制限なし。
- constrained: CDPでCPUを4倍減速、レイテンシ40ms、上下200,000 bytes/s（1.6Mbps）。390×844 viewport。実機の性能を再現する値ではありません。
- 各条件・各フレームワーク20回。サーバーを1回ウォームアップ後、実行順を交互に反転。ブラウザコンテキストは毎回新規、キャッシュ無効。
- FCP・LCPはブラウザのPerformance API。LCPは最初の操作前の観測値。
- readyMsはナビゲーション開始からマウント後のready属性更新まで。イベントが扱える状態の指標で、純粋なhydration処理時間ではありません。
- jsBytesは初期ロードで取得した外部JavaScriptの展開後サイズ。jsGzipBytesは各ファイルを同条件でgzipした合計（推定）。jsEncodedBytesはResource TimingのencodedBodySize合計（実際の圧縮後レスポンス本文）。インラインスクリプト、HTML、CSS、HTTPヘッダーは含みません。
- selectMs・progressMs・navigationMsはプログラムからclickを発火し、期待したDOM更新後の次のrequestAnimationFrameまでの時間。INPや描画完了時間ではありません。進捗は各ロード20回、p95は全ロードの進捗サンプルをまとめて算出します。
- SSRのHTML、10枚表示、進捗値20、ブラウザ例外なし、画面遷移時のdocument維持を計測中に検証します。

この比較はフレームワークの基礎コストを調べる小規模な合成ワークロードです。既存のDropView、画像デコード、HEIC変換、WebRTC、写真のハッシュ処理、Cloudflare Workers、Safari、実機回線は含みません。既存アプリを完全移行した場合の性能や転送速度の結論には使用できません。サーバー実装・圧縮方式の違いも初期ロード時間に含まれます。

公式資料: [React Router Framework Mode](https://reactrouter.com/start/modes)、[SvelteKit adapter-node](https://svelte.dev/docs/kit/adapter-node)。
