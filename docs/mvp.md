# MVP実装メモ

2026-10-04。設計メモの数値未確定項目は以下の暫定値で実装した。iPhone実機での動作保証・最低対応iOS版の確定を意味しない。

## 実装範囲

- Workersが匿名セッションIDと独立した256bit秘密トークンを発行。ブラウザはメモリのみで保持。トークンは最初のWebSocketメッセージで送り、URL・LocalStorageには入れない。サーバーにはトークンのSHA-256と短命の端末情報だけを保持し、同じトークンの再接続は拒否する。
- 受信者のみAccept / Rejectでき、Acceptするまで、SDP・ICE・TURN資格情報の取得を拒否。中止・切断・期限切れは双方に通知する。
- 写真は順序保証付きDataChannelで16KBずつ送信。バッファ量に応じて送信を待機する。受信側で順序、枚数、容量、形式ヘッダー、各写真のSHA-256を検証し、両端末の受信確認後に完了する。原本の転送はWebRTCで行い、写真本体をWebSocket・DOストレージへ送らない。受信後に利用者がHEICプレビュー・JPEG変換を選んだ場合だけ、HTTPでWorker経由のImages bindingに送る。
- JPEG / PNG / WebP / HEIC / HEIFのヘッダーとMIMEを確認。拡張子だけで判定せず、画像を再圧縮しない。HEIC系は原本の共有・ダウンロードに加え、操作時に縮小プレビュー・保存用JPEGを生成する。一般のHEIFコンテナはブラウザがHEIC/HEIF MIMEを提供する場合のみ受け付ける。JPEGへの任意変換を提供し、動画は対象外。
- 1対1の共有リンクは作成から10分間、相手1人の参加にだけ有効。256bitトークンをURLのfragmentに含め、DOにはハッシュと所有者・写真メタデータ・期限を保存。合言葉・位置情報は使用しない。受信画面の読み込み時に自動参加してリンクを消費する。相手の名前・枚数・容量を確認し、「受け取る」を押すまで写真は転送しない。取り消し・再発行・送信者の切断でも失効する。
- 保存はユーザー操作からWeb Share APIを呼ぶ。共有成功を写真ライブラリへの保存確認として扱わない。共有非対応・キャンセル時は写真を維持し、個別ダウンロードを提供。受信完了から10分・破棄・ページ離脱時にBlobの参照とObject URLを解放。保存済みの端末ファイルは削除しない。

- 「みんなに渡す」では同じQRから最大5人が参加し、送信者の確認と各受信者の承諾後に1人ずつ転送する。参加者ごとの状態表示、失敗時の再参加、配布の終了に対応。詳しくは[少人数配布の設計と検証](group-sharing.md)を参照。

## 暫定値と構成

| 項目           | 値                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------ |
| 写真           | 1転送10枚、合計50MiB（UIは50MB表記）、同時転送1人。配布は最大5人                                 |
| 匿名セッション | 30分、切断後は新規セッション                                                                     |
| 共有リンク     | 10分間。1対1は最初の参加だけで転送期限は独立。配布は待機・転送も10分以内                         |
| 受信承諾       | 1対1は要求から2分以内に承諾。配布は期限内に送信者の確認・受信者の承諾が必要                      |
| 転送           | 接続45秒、無進捗60秒、全体最大10分                                                               |
| TURN           | TTL 15分、通常10回・配布送信者15回/セッション、開始許可済みの転送だけ取得可能                    |
| レート制限     | セッション発行20回/分/IP、リンク作成・参加あわせて5回/分/セッション、制御メッセージ240回/分/接続 |
| 調停           | 送信セッションごとのSQLite Durable Object、各ルーム最大200 WebSocket（未認証も含む）             |

認証とIP・アカウントの回数制限はD1で管理する。セッション、共有リンク、WebSocketのメッセージ制限、転送メタデータはDOストレージに有効期限付きで保持し、15秒間隔のalarmで削除する。各参加要求でも期限を確認する。リンク参加の消費処理は `blockConcurrencyWhile` で直列化する。受信完了時に受信者だけへ10分間の変換権限を発行する。写真本体は保存しない。詳細は[写真処理の設計](photos.md)を参照。

Hibernationは `acceptWebSocket` とattachment、短命の転送メタデータからの復元を利用する。定期alarmのため常に休眠し続ける構成ではない。大規模な公開にはD1の負荷・接続前の追加レート制限・alarm頻度・利用量監視を検討する。リンクや表示名は本人認証を保証しない。

## 起動と経路

`mise run dev` でbackend:8787とfrontend:5173を起動する。送信側で写真を選んで「写真を渡す」を押し、別端末のカメラでQRを読み取ってリンクを開き、共有内容を確認して受信承諾する。QRはブラウザ内で生成し、外部のQRサービスには送らない。「リンクで送る」から共有・コピーも可能。開発時の `/api/*` はViteがHTTP/WebSocketともにbackendへ転送する。

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

`mise run test` はVitestで実行し、状態遷移・写真制限・リンクの期限・取り消し・再利用拒否・破損/順序違い/過大受信・SHA-256一致・送信キャンセル・バッファ制御・形式判定を確認する。

`frontend/src/routes/page.scenario.mjs` と `backend/src/index.scenario.mjs` は稼働中の開発サーバーとPlaywright/Chromiumがある環境で実行する。Playwrightはルートの開発依存として固定している。Vitestからの一括実行は `mise run test:e2e` を使う（Storybookも起動が必要）。`PLAYWRIGHT_MODULE` にPlaywrightの `index.mjs` の絶対パス、必要なら `CHROME_PATH` にChromeの実行ファイルを指定する。未指定時は通常の `playwright` と付属Chromiumを使用する。

```sh
# 別ターミナルで mise run dev を起動しておく
mise exec -- node backend/src/index.scenario.mjs
mise exec -- node frontend/src/routes/page.scenario.mjs
```

`TEST_URL` で接続先を変更可能。ブラウザテストは位置情報を許可せず、独立したブラウザコンテキストで1対1共有と5人への配布を検証。辞退・承諾前の接続禁止・承諾後の直接転送・複数枚転送・元データとの一致・受信データ破棄・切断を検証する。モバイル幅390pxのスクリーンショットは `/tmp/pico-drop-received.png` に出力する（`SCREENSHOT_PATH` で変更可能）。APIテストは不正Origin、トークン再利用、第三者操作、承諾前のsignaling/TURN拒否を確認する。

## 2026-10-04の検証結果

- ユニットテスト52件成功。期限境界、同時参加、再利用・取り消し・切断、リンク期限後の転送継続を検証。
- E2Eテスト3件成功。API認証・操作権限、2ブラウザでJPEG 2枚のRTC転送とSHA-256一致、Storybook全19状態のモバイル表示を検証。
- 型検査はエラー・警告なし。lint、整形検査、frontend・backend・docsのビルド成功。
- LINE内ブラウザ・iPhone実機・異なる回線・TURN強制接続は未検証。

## 公開前に残る実機検証

- LINE内ブラウザで参加・RTC・共有シートを確認し、非対応の場合はSafari / Chromeで開く導線を確認。
- iPhone SafariでHTTPS接続し、JPEGを受信して共有シートから写真アプリへ保存、共有キャンセル、複数枚・上限付近のメモリを確認。
- 実際のHEIC/HEIFファイルの選択・転送・保存を端末の組み合わせごとに確認。最低対応iOS版を決定。
- iPhone同士・iPhoneとPC、Wi-Fiと携帯回線、TURNを強制するテスト設定で転送を確認。TURN資格情報はこの環境では未設定。
- Cloudflare上でservice binding/WebSocket経路、Hibernation後の制御状態復元、期限切れの回収を確認。ローカルのdry-runはクラウドでの動作保証ではない。
- 画面ロック・バックグラウンド・回線変更からの中断/再試行。途中再開は実装せず、写真の選択を維持して再送する。

リンクや表示名は本人認証を保証しません。意図した相手だけに共有してください。1対1共有は受信者が要求から2分以内に承諾すると転送を開始し、配布では送信者による相手の確認も必要です。
