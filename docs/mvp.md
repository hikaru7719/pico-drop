# MVP実装メモ

2026-09-24。設計メモの数値未確定項目は以下の暫定値で実装した。iPhone実機での動作保証・最低対応iOS版の確定を意味しない。

## 実装範囲

- Workersが匿名セッションIDと独立した256bit秘密トークンを発行。ブラウザはメモリのみで保持。トークンは最初のWebSocketメッセージで送り、URL・LocalStorageには入れない。サーバーにはトークンのSHA-256と短命の端末情報だけを保持し、同じトークンの再接続は拒否する。
- 受信者のみAccept / Rejectでき、Acceptするまで、SDP・ICE・TURN資格情報の取得を拒否。中止・切断・期限切れは双方に通知する。
- 写真は順序保証付きDataChannelで16KBずつ送信。バッファ量に応じて送信を待機する。受信側で順序、枚数、容量、形式ヘッダー、各写真のSHA-256を検証し、両端末の受信確認後に完了する。原本の転送はWebRTCで行い、写真本体をWebSocket・DOストレージへ送らない。受信後に利用者がHEICプレビュー・JPEG変換を選んだ場合だけ、HTTPでWorker経由のImages bindingに送る。
- JPEG / PNG / WebP / HEIC / HEIFのヘッダーとMIMEを確認。拡張子だけで判定せず、画像を再圧縮しない。HEIC系は原本の共有・ダウンロードに加え、操作時に縮小プレビュー・保存用JPEGを生成する。一般のHEIFコンテナはブラウザがHEIC/HEIF MIMEを提供する場合のみ受け付ける。JPEGへの任意変換を提供し、動画は対象外。
- Geolocationは利用者が探索を開始した時だけ要求。座標を他端末へ返さず、候補にはID・表示名だけを返す。位置拒否・取得失敗・誤差の説明と再試行を提供。
- 保存はユーザー操作からWeb Share APIを呼ぶ。共有成功を写真ライブラリへの保存確認として扱わない。共有非対応・キャンセル時は写真を維持し、個別ダウンロードを提供。受信完了から10分・破棄・ページ離脱時にBlobの参照とObject URLを解放。保存済みの端末ファイルは削除しない。

## 暫定値と構成

| 項目           | 値                                                                               |
| -------------- | -------------------------------------------------------------------------------- |
| 写真           | 1転送10枚、合計50MiB（UIは50MB表記）、1接続1転送                                 |
| 匿名セッション | 30分、切断後は新規セッション                                                     |
| Nearby         | 基準300m + 各端末の測位誤差（各最大500m）、距離表示なし                          |
| 測位           | 30秒ごと、取得タイムアウト15秒、誤差10km超は再試行                               |
| Presence       | 最終測位から90秒、切断時も除外                                                   |
| 受信承諾       | 受信者が承諾すると転送開始、要求から2分以内                                      |
| 転送           | 接続45秒、無進捗60秒、全体最大10分                                               |
| TURN           | TTL 15分、1セッション10回まで、開始許可済みの転送だけ取得可能                    |
| レート制限     | セッション発行20回/分/IP、送信要求5回/分/セッション、制御メッセージ240回/分/接続 |
| 調停           | 単一SQLite Durable Object、最大200 WebSocket（未認証も含む）                     |

小規模MVPのため、DOをエリア分割せず候補を距離で絞る。経度±180度の境界にも対応する。位置情報はWebSocket attachmentに保持し、期限切れ時に除去する。セッション、レート制限カウンタ、転送メタデータはDOストレージに有効期限付きで保持し、15秒間隔のalarmで削除する。写真・生の座標をDOストレージに書き込まない。受信完了時に受信者だけへ10分間の変換権限を発行する。DOにはトークンのハッシュ・写真メタデータ・試行回数・期限だけを保存する。詳細は[写真処理の設計](photos.md)を参照。

Hibernationは `acceptWebSocket` とattachment、短命の転送メタデータからの復元を利用する。定期alarmのため常に休眠し続ける構成ではない。大規模な公開にはエリア分割・接続前の追加レート制限・alarm頻度・利用量監視を検討する。位置情報や表示名は本人認証を保証しない。

## 起動と経路

`mise run dev` でbackend:8787とfrontend:5173を起動する。2つのブラウザでfrontendを開き、双方で位置情報を許可して探索する。開発時の `/api/*` はViteがHTTP/WebSocketともにbackendへ転送する。

本番はbackend、frontendの順でdeployする。frontendのSvelteKit APIルートが `BACKEND` service bindingへ元のRequestを渡し、backendはOriginとRequest URLのoriginの一致を必須にする。ワイルドカードCORSを許可しない。Worker名を変更する場合はfrontendのservice bindingも変更する。

## TURN

backendのSecretsに `TURN_KEY_ID` と `TURN_KEY_API_TOKEN` を設定する。ローカルでは `backend/.dev.vars` で設定できる。両方が未設定の場合はCloudflare STUNのみを返し、画面に中継未設定を表示する。

設定済みの場合はWorkersが短命資格情報を発行し、ブラウザはSTUN / TURN候補を同時にICEへ渡す。経路の選択はブラウザのICEに任せる。独自のTURN再接続処理は追加しない。資格情報発行失敗時はエラーにして再試行を案内する。

参考: [Cloudflare TURN credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/)、[DO WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)。

## 自動検証

```sh
mise run test
mise run check
mise run lint
mise run format:check
mise run build
```

`mise run test` はNode.js標準テストランナーで実行し、状態遷移・写真制限・座標境界・破損/順序違い/過大受信・SHA-256一致・送信キャンセル・バッファ制御・形式判定を確認する。

`frontend/src/routes/page.scenario.mjs` と `backend/src/index.scenario.mjs` は稼働中の開発サーバーとPlaywright/Chromiumがある環境で実行する。Playwrightはルートの開発依存として固定している。Vitestからの一括実行は `mise run test:e2e` を使う（Storybookも起動が必要）。`PLAYWRIGHT_MODULE` にPlaywrightの `index.mjs` の絶対パス、必要なら `CHROME_PATH` にChromeの実行ファイルを指定する。未指定時は通常の `playwright` と付属Chromiumを使用する。

```sh
# 別ターミナルで mise run dev を起動しておく
mise exec -- node backend/src/index.scenario.mjs
mise exec -- node frontend/src/routes/page.scenario.mjs
```

`TEST_URL` で接続先を変更可能。ブラウザテストはGeolocationを固定値にし、独立した2つのブラウザコンテキストで辞退・承諾前の接続禁止・承諾後の直接転送・複数枚転送・元データとの一致・受信データ破棄・切断を検証する。モバイル幅390pxのスクリーンショットは `/tmp/pico-drop-received.png` に出力する（`SCREENSHOT_PATH` で変更可能）。APIテストは不正Origin、トークン再利用、第三者操作、承諾前のsignaling/TURN拒否を確認する。

## この環境で確認した結果

- `mise run check`: TypeScript / Svelteともにエラー・警告なし。
- `mise run test`: 16件成功。`mise run lint`、`mise run format:check`、`mise run build`も成功。
- Chromeの独立した2コンテキストで、辞退・承諾前の接続禁止・承諾後の直接転送・JPEG 2枚の転送とSHA-256一致・390px幅の表示・共有非対応の代替導線・未保存写真の保持・破棄・切断を確認。GPSと共有非対応はテスト内で設定した条件。
- APIテストで不正Origin、無効/再使用トークン、第三者操作、送信者の承諾/完了、承諾前のsignaling/TURN、終了済み転送の操作を拒否することを確認。
- 開発用Vite proxyに加え、ビルド成果物をローカルWorkersで起動した `http://localhost:4173` のservice binding経路でもAPIテスト・写真転送テストが成功。Cloudflareへの公開は未実施。

## 公開前に残る実機検証

- iPhone SafariでHTTPS接続し、JPEGを受信して共有シートから写真アプリへ保存、共有キャンセル、複数枚・上限付近のメモリを確認。
- 実際のHEIC/HEIFファイルの選択・転送・保存を端末の組み合わせごとに確認。最低対応iOS版を決定。
- iPhone同士・iPhoneとPC、Wi-Fiと携帯回線、TURNを強制するテスト設定で転送を確認。TURN資格情報はこの環境では未設定。
- Cloudflare上でservice binding/WebSocket経路、Hibernation後の制御状態復元、期限切れの回収を確認。ローカルのdry-runはクラウドでの動作保証ではない。
- 画面ロック・バックグラウンド・回線変更からの中断/再試行。途中再開は実装せず、写真の選択を維持して再送する。

位置情報や表示名は本人認証を保証しません。送信前に相手の端末名を確認し、受信者が要求から2分以内に承諾すると転送を開始します。
