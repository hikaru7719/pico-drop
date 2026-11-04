# パスキー認証

送信者はパスキーで登録・ログインします。受信者は匿名セッションのまま共有リンクから参加できます。初回はユーザーIDを入力してパスキーを保存し、次回はユーザーIDを入力せず保存済みパスキーを選びます。メールアドレス・パスワードは収集しません。

参考にしたのはVlogアプリsetlogのパスキーを入口にする体験です。[公式ヘルプ](https://setlog.notion.site/setlog-33c7a780f48e80e6bc75f119078f0c0f?pvs=143)を参照しました。setlogのサーバー実装やソースコードは参照していません。署名検証には[SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server)を使用します。

## 設定

`mise run //backend:deploy` は、バックエンドの `AUTH_ORIGIN` にフロントエンドの公開オリジン `https://pico-drop-frontend.pico-drop-backend.workers.dev` を設定します。公開ドメインを変更する場合は、`backend/mise.toml` のデプロイ引数を更新してください（末尾 `/` なし）。未設定・不一致なら公開環境では認証を拒否します。ローカル開発にはこのデプロイ引数を適用しません。

ローカルでは `http://localhost:5173` または `http://127.0.0.1:5173` のオリジンを使用できます。任意のホスト名での自動判定は行いません。WebAuthnのRP IDは設定したオリジンのホスト名です。公開ドメインの変更は既存パスキーの利用可否に影響するため、登録を始める前に固定してください。外部の認証プロバイダーや鍵の設定は不要です。

## セッションと権限

- アカウント、パスキーの公開鍵・credential ID・署名カウンター、チャレンジ、ログインをD1の `DB` bindingに保存します。秘密鍵と生体情報はサーバーに送りません。
- 登録にはdiscoverable credentialを要求し、登録・ログインともuser verificationを必須にします。チャレンジ・オリジン・RP ID・署名を検証します。
- チャレンジは5分有効・1回限り。ブラウザのHttpOnly Cookieに結び付け、検証失敗時も消費します。別タブで認証を始めた場合、同じブラウザの古いチャレンジは無効になります。
- ログインは7日間有効。ランダムなトークンのハッシュだけを保存し、CookieにはHttpOnly・SameSite=Strict・HTTPS時Secureと `__Host-` 接頭辞を設定します。再ログイン時は現在のCookieのセッションを失効させます。
- WebSocketの端末セッションにサーバー側でログインセッションを紐付けます。共有リンク作成のたびにログイン期限・失効・アカウント無効化を確認します。匿名参加者が直接 `create-link` を送っても拒否します。
- ログアウトはサーバーのログインセッションを削除します。作成済みの共有リンク・転送は従来の期限・取り消し操作で終了し、次のリンク作成は拒否します。

## 利用制限

認証の開始・検証をIPごとに10分30リクエスト、共有リンク作成をアカウントごとに24時間30回に制限します。認証の開始と検証はそれぞれ1リクエストです。24時間枠は最初のリンク作成時から数え、端末セッションを作り直してもリセットしません。既存のIP単位の端末セッション発行制限とWebSocketのメッセージ制限も継続します。認証入力は24KBまでです。

アカウントの `disabled` をサーバーの保存レコードでtrueにするとログインと新規送信を拒否します。管理画面・管理APIは今回の範囲に含めません。パスキーだけではアカウントの量産や本人の実在確認は防げません。サービス全体の費用上限や招待制は別の対策です。

## 復旧と検証

この段階ではメール復旧・パスキー追加・アカウント統合を提供しません。保存先の同期や別端末のパスキーを利用できなくなると、同じアカウントへの復旧はできません。新規登録を自動でログイン失敗時の代替にせず、画面で登録とログインを明示的に選びます。

`mise run test` でチャレンジの期限・使い捨て・ブラウザへの紐付け、ログアウト失効、匿名送信の拒否、アカウント無効化、利用制限を検証します。`mise run test:e2e` はChromiumの仮想認証器で実際の登録・ログアウト・再ログイン・署名検証・写真転送を行います。実機Safari/iPhone・Androidのパスワード管理サービスとの組み合わせは公開前に確認してください。

## D1とWebSocket用DO

各テーブル・KV・WebSocket attachmentのフィールド定義、データ間の参照と保存期間は [データの概念スキーマとフィールド定義](data-schema.md) を参照してください。

認証APIはWorkerからD1へ直接接続します。認証シャード、認証RPC、旧 `mvp` へのフォールバックは使いません。アカウントIDはUUID、Cookieのトークンは256bitのランダム値です。チャレンジとログインはトークンのSHA-256をキーとして保存します。署名検証ではuserHandleとアカウントIDの一致、有効状態も確認します。

D1には `accounts`、`credentials`、`logins`、`challenges`、`rate_limits` の5テーブルを作ります。公開鍵はBLOBで保存し、取得時に `Uint8Array` へ復元します。チャレンジは `DELETE ... RETURNING`、回数制限は条件付きUPSERTで原子的に更新します。アカウントとcredentialはD1の `batch()` でまとめて登録し、credentialが重複した場合はアカウント作成もロールバックします。署名カウンターの更新は検証前の値との比較付きにし、並行ログインによる上書きを拒否します。

認証・送信・端末セッション発行の回数制限も同じD1で管理し、ルームを変えてもリセットしません。IPはSHA-256で保存します。有効期限は読み取り時にも検査し、15分ごとのScheduled Handlerで期限切れのチャレンジ・ログイン・制限レコードを削除します。アカウントとcredentialは削除しません。

WebSocketとその制御状態は `RoomObject` DOに残します。送信セッションごとの `room:<16桁hex>` に接続し、共有リンク・接続トークン・写真変換トークンの先頭16桁から同じルームへ戻ります。残り48桁はランダムな秘密で、ルームIDだけでは操作できません。端末セッション、共有リンク、転送状態、変換権限はルームのDOストレージで管理し、Hibernation後にも復元します。リンク作成時のログイン失効・送信上限はD1で確認します。

現在はアプリ全体で1つのD1を使います。書き込み先はそのプライマリに集まり、DOのようにルーム単位には分散しません。

## 宣言的なスキーマ管理

テーブル・制約・インデックスの宣言は `backend/schema.sql` を正とします。sqldefのSQLite用CLI `sqlite3def` をmiseで3.11.28に固定し、実行時のSQLアクセスにはWorkersの `prepare().bind()`・`batch()` を使います。

スキーマ変更時は宣言を編集し、リポジトリルートで次を実行します。

```sh
mise run //backend:db:generate -- add_login_index
mise run //backend:db:migrate:local
mise run verify
```

生成処理は `backend/migrations/*.sql` を一時SQLiteへ順番に再現し、そのスキーマと `schema.sql` をsqldefで比較します。本番や開発用DBの実データ・スキーマには接続しません。生成した差分を一時SQLiteへ適用して宣言との一致を再確認し、連番付きSQLファイルへ保存します。差分がなければファイルは作りません。Wranglerがトランザクションを管理するため、sqldefの出力の外側にある `BEGIN` / `COMMIT` は除去します。

`schema.sql` と生成したSQLの両方をGit管理します。適用済みSQLは編集せず、変更は新しいmigrationとして追加してください。列・テーブルの削除もSQLに生成されるため、差分を確認してから適用します。sqldefが対応しない変更は生成時に失敗します。その場合は追加のSQL migrationを作成し、`schema.sql` も最終状態へ更新します。改名も生成結果が意図したものか確認してください。

`mise run //backend:db:check` は履歴と宣言の不一致をエラーにします。backendのビルドでも実行するため、`mise run verify` で生成漏れを検出できます。D1への適用履歴はWranglerの `d1_migrations` だけで管理します。

## 初回導入と既存データの破棄

旧DOデータは移行しません。DO migration `v2-d1-auth` は `NearbyHub` を削除し、ルーム専用の `RoomObject` を作成します。既存のアカウント・パスキー登録・ログイン・チャレンジ・共有リンク・接続・変換権限は全て無効になります。更新後は再登録し、共有リンクを作り直してください。端末のパスキーマネージャーに残る旧パスキーは自動削除されません。

ローカルでは `mise run dev` がD1 migrationを適用してからbackendを起動します。単独で適用する場合は `mise run //backend:db:migrate:local` を実行します。

本番への初回導入は、リポジトリルートで次を実行します。

```sh
mise exec -- wrangler d1 create pico-drop --config backend/wrangler.jsonc --binding DB --update-config
mise run //backend:db:migrate:remote
mise run //backend:deploy
mise run //frontend:deploy
```

作成コマンドで `backend/wrangler.jsonc` に実際の `database_id` を設定します。既にDBを作成済みなら、そのIDを `DB` bindingへ設定してからmigrationを適用してください。DB作成とmigrationを先に行い、テーブルがある状態でbackendを公開します。以後のスキーマ変更でも公開前にremote migrationを適用します。設定変更後は `mise run gen` で型を再生成します。

## クラスの責務

`authentication(env)` はD1に接続した `AuthService` を生成し、`RoomObject` が保持して利用します。ログイン・送信認可の判定は呼び出しのたびにD1を参照するため、ログアウトやアカウントの無効化を確認できます。HTTP入口でだけ `authenticationApi(env)` がそのサービスを `PasskeyAuth` に渡してHonoのルーターを構築します。

| クラス        | ファイル                                    | 責務                                                                             |
| ------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| `D1AuthStore` | `backend/src/infrastructure/d1-store.ts`    | 認証データの永続化、原子的な消費・登録・回数制限、期限切れ削除                   |
| `AuthService` | `backend/src/application/auth.ts`           | 登録・ログイン・署名検証・送信認可。認証HTTPは `PasskeyAuth` が担当              |
| `RoomObject`  | `backend/src/infrastructure/room-object.ts` | DOのイベント受付、WebSocket受け入れ、保持する `RoomService` とDO・D1・TURNの接続 |
| `RoomService` | `backend/src/application/room.ts`           | セッション・共有リンク・転送・写真変換権限の管理と期限切れ処理                   |

`index.ts` はHonoアプリとScheduled Handlerを組み立て、`RoomObject` をexportします。層の責務と依存方向は [ADR-0003](adr/0003-layered-backend-with-hono.md) を参照してください。
