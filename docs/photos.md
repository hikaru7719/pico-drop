# 短命な受信写真とHEIC変換

原本の転送はWebRTC、探索・受信承諾・期限付きの変換権限はDurable Objectsで管理する。HEIC/HEIFのプレビューと任意のJPEG変換だけ、WorkerからCloudflare Images bindingを呼ぶ。R2やImagesのホスト画像ストレージは使わない。

## 操作と保存期間

- 受信完了から10分間、原本と生成したプレビュー・JPEGをブラウザのメモリだけに保持する。期限はDOが発行する。転送終了通知を受け取れなかった場合はローカルの10分期限だけで原本を保持し、変換権限は与えない。
- JPEG/PNG/WebPは端末内でプレビュー。HEIC/HEIFは「プレビューを表示」で縮小JPEG、「JPEGに変換する」で元の画素寸法のJPEGを生成する。変換ボタンの近くにCloudflareへの送信を明記する。自動アップロードはしない。
- 保存用JPEGは生成後に「JPEGをダウンロード」「JPEGを保存・共有」を表示する。共有は別のユーザー操作で開始し、Web Share APIのユーザー操作要件を守る。原本を上書きしない。
- 受信期限、明示破棄、ページ離脱時にObject URLとFile参照を解放し、処理中のHTTPリクエストを中止する。画面復帰、可視状態変更、保存・変換操作でも絶対時刻を確認する。期限後に届いた変換結果は表示しない。
- OSやブラウザが停止している間の指定時刻のメモリ消去は保証しない。復帰時に期限を確認する。利用者が端末へ保存したファイルは削除できない。

## 変換権限

`ended: complete` の受信者への通知にだけ、256bitランダムトークンと有効期限を添付する。送信者、第三者、未承諾・未完了の転送には権限を発行しない。セッションを切断しても、受信者は期限内の変換を続けられる。

DOには `photo:<SHA-256(token)>` として写真ID・形式・サイズ・期限・試行回数だけを保存する。写真は保存しない。既存alarmで期限切れを回収する。破棄時の失効通知に失敗しても、期限は延長されない。

- `POST /api/photos/convert?id=<photo-id>&mode=preview|jpeg`：トークンをAuthorizationヘッダー、原本をリクエストボディに送る。同一Originを要求し、DOのRPCで期限・写真ID・形式・試行回数を確認する。DOへ画像ボディを渡さない。
- `POST /api/photos/discard`：同じトークンで権限を削除する。ページ離脱時はkeepaliveでベストエフォート送信する。
- 写真ごと・モードごとに最大3回の試行。カウントはDO内で直列化し、失敗も数える。元の転送のサイズと一致するボディだけを受け付け、HEIFヘッダーを検査する。変換前後にも期限を確認する。
- 原本転送は10枚・合計50MiBのまま、変換は1枚20MiBまで。上限超過や未対応のHEIF、サービス障害でも原本の保存は可能。
- 縮小プレビューは640×640内、JPEG品質75。保存用はリサイズなし・品質90。JPEG化は非可逆で、EXIF等の保持は保証しない。回転・色・実際のメタデータの扱いは実画像で検証する。

APIは成功・エラーとも `Cache-Control: no-store`。WorkerのCache API、画像の公開URL、LocalStorage、IndexedDBへ写真や変換結果を保存しない。Cloudflareで画像処理するため、原本の端末間転送と同じ通信経路・秘匿性とは説明しない。

## 設定・検証

`backend/wrangler.jsonc` の `images.binding = "IMAGES"` を使用する。Images変換を利用できるアカウントが必要で、変換料金が発生しうる。Hosted ImagesへのアップロードAPIや管理用APIキーは不要。

単体テストで権限、期限、試行上限、ボディサイズ、変換失敗、no-store、ブラウザの破棄・遅延レスポンスを検証する。Images処理自体はモックであり、実HEICのデコード成功を保証しない。Cloudflare上とiPhone/Android実機で、HEIC/HEIFの変換、向き、色、画素数、共有保存、20MiB付近・高画素写真の失敗時表示を確認する。

参考：[Images binding](https://developers.cloudflare.com/images/optimization/binding/)、[対応形式・制限](https://developers.cloudflare.com/images/get-started/limits/)

## 今回の検証結果

ローカルChromeの2つの独立したブラウザで、従来のWebRTC転送の回帰テストとHEIC形式のテストデータの転送を確認した。受信者だけへの権限発行、変換失敗後の原本保持、成功レスポンスを代替したプレビュー/JPEG操作、390px幅の表示、期限到達後の表示破棄とDOの権限失効を確認。Cloudflare実サービスでのHEICデコード・実機での画質確認は未実施。
