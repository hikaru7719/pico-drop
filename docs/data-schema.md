# データの概念スキーマとフィールド定義

2026-11-04時点の実装を説明する。D1のSQLスキーマは [backend/schema.sql](../backend/schema.sql)、ルームDOの保存形式は [RoomService](../backend/src/application/room.ts) と [写真変換権限](../backend/src/application/photo-access.ts) を正とする。認証の運用・設定は [パスキー認証](auth.md)、写真の扱いは [写真処理の設計](photos.md)、配布の操作は [少人数配布の設計と検証](group-sharing.md) を参照。

## 保存先と責務

| 保存先                              | 単位            | 内容                                                                 | アクセス方法                                                            |
| ----------------------------------- | --------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| D1（`DB` binding）                  | アプリ全体で1つ | アカウント、パスキーの公開情報、ログイン、認証チャレンジ、利用制限   | SQL。宣言は `backend/schema.sql`、実装は `D1AuthStore`                  |
| ルームDOストレージ（`HUB` binding） | ルームIDごと    | 端末セッション、共有リンク、転送状態、写真変換権限、ルームID         | SQLiteバックエンドのDOを、`storage.get/put/delete/list` のKV APIで利用  |
| WebSocket attachment                | 接続ごと        | 接続時刻、認証済みセッション、リンク・転送との対応、接続内の回数制限 | `serializeAttachment` / `deserializeAttachment`。DOのKVキーとは別に保持 |

D1の5テーブルと、各DO専用のSQLiteストレージは別のデータベースである。DOのKV APIは、このDO専用ストレージをキー・値で扱うもので、Cloudflare Workers KVのnamespaceとは別である。ルームDOにはアプリ独自のSQLテーブルを定義していない。D1のスキーマを変更しても、DOのKVの値の形は変わらない。

写真本体、変換後の画像、パスキーの秘密鍵・生体情報は、これらのストアに保存しない。写真メタデータのファイル名・形式・容量は保存する。原本はWebRTCで転送し、HEIC/HEIF変換時は利用者が送った画像をサーバーで処理して結果を返す。変換の詳細は [写真処理の設計](photos.md) を参照。

## `RoomObject`・`RoomService` の関係

CloudflareにDOとして登録するクラスは `RoomObject` の1つだけである。`RoomObject` が `RoomService` を保持し、Cloudflareのイベント受付と業務処理を分担する。両者は同じDOのストレージと接続を利用する。

| クラス        | 継承・生成の関係                                                                                            | 担当する処理                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `RoomObject`  | Cloudflareの `DurableObject<Bindings>` を継承。インスタンスの初期化時に `RoomService` を1つ生成して保持する | HTTP・写真権限RPC・WebSocket・Alarmの受付、Honoとの接続、WebSocketの受け入れと200接続の上限、DO・認証・ICE取得の依存の組み立て |
| `RoomService` | `RoomRuntime` と `RoomDependencies` を受け取る。`RoomObject` との継承関係はない                             | セッション・リンク・グループ参加・転送・写真変換権限の管理、メッセージ処理、期限切れ掃除などのユースケース                     |

`RoomObject` → `RoomService` は生成・保持と委譲の関係である。例えば `RoomObject.webSocketMessage()` は、保持するサービスの `this.service.webSocketMessage()` を呼ぶ。サービスはDOの実行インスタンス内で使い回し、Cloudflareの実行環境がなくてもインターフェースの実装を渡して単独でテストできる。

HTTPでは `RoomObject.fetch()` → `roomApp`（Hono）→ `RoomService` の処理へ進む。WebSocketへのUpgradeだけは `roomApp` から `RoomObject` の `upgradeSocket()` を呼び、`WebSocketPair`・`acceptWebSocket()`・101レスポンスで接続を確立する。その後のメッセージ・切断・エラーはDOのイベント入口からサービスへ渡す。

`RoomObject` はサービスの生成時に以下を渡す。

| 渡すもの                            | 接続する実装                       | サービスからの利用                                   |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| `RoomRuntime.storage`               | 同じDOの `state.storage`           | KVとAlarmの読み書き                                  |
| `RoomRuntime.getRoomSockets`        | `state.getWebSockets()`            | 接続一覧と、相手のWebSocketの検索                    |
| `RoomRuntime.blockConcurrencyWhile` | `state.blockConcurrencyWhile()`    | 状態を読み書きする処理の排他                         |
| `RoomDependencies.identity`         | D1を使う `AuthService.identity()`  | セッション発行時のアカウント取得                     |
| `RoomDependencies.allowSend`        | D1を使う `AuthService.allowSend()` | リンク作成時のログイン確認・アカウント単位の送信制限 |
| `RoomDependencies.iceServers`       | TURN設定に応じたICE設定取得        | 転送開始後の接続設定発行                             |

`RoomService` はCloudflareの実装を直接生成せず、上記インターフェースを通して利用する。ただしソケットのインターフェースにはattachmentの読み書きも含まれており、接続状態の管理はその機能を前提にしている。

`RoomObject` はD1に接続した `AuthService` も保持し、サービスの `identity`・`allowSend` を直接渡す。認証HTTP用のHonoルーターはDO内では生成しない。認証状態そのものはキャッシュせず、判定時にD1を参照する。

Cloudflareが休止後などに `RoomObject` を再生成すると、保持する `RoomService` も新しく生成する。永続的なルーム状態はクラスのフィールドではなく同じDOのKVとWebSocket attachmentに置くため、再生成したサービスも保存済みの状態を参照できる。

実装は [room-object.ts](../backend/src/infrastructure/room-object.ts)、[application/room.ts](../backend/src/application/room.ts)、[room-ports.ts](../backend/src/application/room-ports.ts)、[api/room.ts](../backend/src/api/room.ts) を参照。レイヤーの設計方針は [ADR-0003](adr/0003-layered-backend-with-hono.md) に記載する。

## 概念上のエンティティと関係

| 関係                                | 対応するフィールド                       | 多重度と整合性                                                                                           |
| ----------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| アカウント → パスキー               | `accounts.id` → `credentials.account_id` | 1対多を許すSQL外部キー。現在の登録処理は新規アカウントと1件のパスキーを同時作成。追加パスキーのAPIはない |
| アカウント → ログイン               | `accounts.id` → `logins.account_id`      | 1対多のSQL外部キー。異なるブラウザのログインを保持できる                                                 |
| 登録チャレンジ → 登録予定アカウント | `challenges.account_id/account_name`     | 未登録アカウントの情報を一時保持。SQL外部キーではない                                                    |
| ログイン → 端末セッション           | `logins.id` ← DOの `session.authKey`     | 1つのログインを複数ルーム・複数セッションから参照できる。D1とDOをまたぐアプリ上の参照                    |
| ルーム → 端末セッション             | 同じDO内の `session:<hash>`              | 1ルームに送信者・受信者の複数セッション。`routing:room` とセッションの `room` にルームIDを保持           |
| 送信セッション → 共有リンク         | `session.id` ← `link.owner`              | 接続の `linkKey` で現在のリンクを管理。作り直す際は古いリンクを失効させる                                |
| 共有リンク → 転送                   | `link:<hash>` ← `transfer.groupKey`      | グループ配布ではリンクに複数の個別転送が所属。1対1では参加時にリンクを消費し、転送にリンクキーを残さない |
| 転送 → 送受信セッション             | `transfer.from.id/to.id` → `session.id`  | 各転送に送信者・受信者が1人ずつ。KVに外部キー制約はない                                                  |
| グループ参加者 → 個別転送           | `link.participants[].id` → `transfer.id` | 現在の試行の転送IDを保持。転送終了後も結果をリンク内に残すため、転送レコードが削除済みの場合がある       |
| 完了した転送 → 写真変換権限         | 完了時に転送の `files` を権限へ複製      | 受信者に専用トークンを通知。権限の値に転送ID・セッションIDは保存しない                                   |

SQLの外部キーは `credentials.account_id` と `logins.account_id` のみで、いずれも `ON DELETE CASCADE`。D1のログイン削除からDOのセッション・リンク・転送へ連鎖削除は行わない。リンク作成時に `authKey` からログイン・アカウントを確認し直す。

### 識別子とトークン

| 名称                     | 形式・生成                                      | 役割                                                                                   |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| アカウントID             | UUID                                            | 長期の認証主体。ルームや端末セッションを変えても同じ                                   |
| credential ID            | WebAuthnライブラリから得る文字列                | パスキーを識別する。アプリが生成するUUIDではない                                       |
| ルームID                 | 16桁の小文字hex                                 | DOを選ぶルーティング情報。DO名は `room:<roomId>`                                       |
| 端末セッションID         | セッション発行ごとのUUID                        | ルーム内の接続者を識別する。アカウントID・実端末の固定IDとは別                         |
| 転送ID                   | 転送作成ごとのUUID                              | 送信者と受信者1人の受け渡しを識別する。再試行時は新しいID                              |
| 認証・チャレンジトークン | 64桁の小文字hex（32バイトのランダム値）         | Cookieで保持し、ハッシュからD1の行を検索する                                           |
| ルーム用トークン         | 先頭16桁がルームID、残り48桁がランダムな64桁hex | 端末セッション・共有リンク・写真変換権限ごとに個別発行。同じDOへ戻る情報と秘密を兼ねる |
| 写真ID                   | クライアント指定の1〜40文字の英数字・ハイフン   | 1回の写真セット内で一意。アプリ全体で一意のDB主キーではない                            |

ルーム未指定の `POST /api/session` は新しいルームIDを発行する。同じアカウントでも新しい送信セッションを作れば別DOとなる。受信者は共有トークンの先頭16桁を指定して同じDOに参加する。同じルーム内でのリンクの作り直しはDOを増やさない。

以下の `hash(token)` と `hash(IP)` は、入力全体のSHA-256を64桁の小文字hexにしたものを指す。ルームIDだけではトークンの代わりにならない。トークン本体はD1・DOの保存値に含めず、ハッシュ付きのキーで検索する。

## D1のテーブル

`expires_at` はすべてミリ秒のUnix時刻。SQLiteの `INTEGER` に保存し、アプリでは `number` として扱う。以下で「必須」はSQLの `NOT NULL` を表す。アプリの型では `account_id` → `account`、`expires_at` → `expiresAt` などに変換する。

### `accounts`：アカウント

| フィールド | SQL型・制約                                               | 役割                                                                                        |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`       | `TEXT`、必須、主キー                                      | アカウントのUUID。WebAuthnのuser IDにも使う                                                 |
| `name`     | `TEXT`、必須                                              | 登録時の表示名。UI上の「ユーザーID」の入力値だが、一意制約はなく、認証の検索キーではない    |
| `disabled` | `INTEGER`、必須、既定値 `0`、`CHECK (disabled IN (0, 1))` | `1` は無効。読み出し時にbooleanへ変換し、ログイン・認証主体の取得・新規リンク作成を拒否する |

表示名は登録時に整形し、1〜40文字の入力を受け付ける。アカウントの自動期限・定期削除はない。無効化・削除用の管理APIは実装していない。無効化しても、作成済みリンク・進行中の転送を直ちに全削除する処理はない。

### `credentials`：パスキーの公開情報

| フィールド   | SQL型・制約                               | 役割                                                                                   |
| ------------ | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `id`         | `TEXT`、必須、主キー                      | WebAuthn credential ID。ログイン時に受け取ったIDで取得する                             |
| `account_id` | `TEXT`、必須、`accounts(id)` への外部キー | パスキーの所有アカウント。アカウント削除時に連鎖削除                                   |
| `public_key` | `BLOB`、必須                              | 署名検証用公開鍵。ライブラリの公開鍵バイト列を保存し、取得時に `Uint8Array` へ復元する |
| `counter`    | `INTEGER`、必須                           | ライブラリが署名検証で使うカウンター。認証成功時に `newCounter` へ更新する             |
| `transports` | `TEXT`、NULL可                            | WebAuthn transports配列のJSON文字列。未指定ならNULL。取得時にJSONから復元する          |

`counter` の更新は `WHERE id = ? AND counter = <検証前の値>` で比較し、更新行数が1でなければ並行更新として失敗させる。単純なアプリのログイン回数ではなく、認証器が報告する署名カウンターを保存する。アカウントとcredentialの登録はD1の `batch()` でまとめて行う。credentialの自動期限・定期削除はない。

### `logins`：ログイン状態

| フィールド   | SQL型・制約                               | 役割                                                                  |
| ------------ | ----------------------------------------- | --------------------------------------------------------------------- |
| `id`         | `TEXT`、必須、主キー                      | `auth:login:<hash(authCookieToken)>`。DOが持つ `authKey` と同じ文字列 |
| `account_id` | `TEXT`、必須、`accounts(id)` への外部キー | ログイン中のアカウント。アカウント削除時に連鎖削除                    |
| `expires_at` | `INTEGER`、必須                           | 発行から7日後。読み取り時に期限切れ行を除外する                       |

HTTPSではブラウザの `__Host-pico_auth` Cookieに生のトークンを保持し、D1にはハッシュを含むキーを保存する。ローカルHTTPではCookie名は `pico_auth`。ログアウトで該当行を削除し、再ログインでは現在のCookieに対応する行を削除して新しいトークンを発行する。他のブラウザの全ログインを一括削除する処理ではない。

### `challenges`：認証手続きの一時状態

| フィールド     | SQL型・制約                                    | 役割                                                                                                         |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `id`           | `TEXT`、必須、主キー                           | `auth:challenge:<hash(challengeCookieToken)>`。手続きをブラウザのCookieに結び付ける                          |
| `kind`         | `TEXT`、必須、`register` / `login` のCHECK制約 | 登録用かログイン用かを識別し、別の検証処理への流用を拒否する                                                 |
| `challenge`    | `TEXT`、必須                                   | WebAuthnのチャレンジ文字列。Cookieトークンとは別で、署名検証時の期待値                                       |
| `account_id`   | `TEXT`、NULL可                                 | 登録予定アカウントのUUID。登録開始時点では `accounts` 行が存在しないため外部キーを付けない。ログイン用はNULL |
| `account_name` | `TEXT`、NULL可                                 | 登録完了時に保存する表示名。アプリは登録用でID・名前を両方保存し、ログイン用では両方NULLにする               |
| `expires_at`   | `INTEGER`、必須                                | 発行から5分後                                                                                                |

HTTPSのCookie名は `__Host-pico_challenge`、ローカルHTTPでは `pico_challenge`。新しい手続きの開始時に現在のCookieに対応するチャレンジを削除する。検証時は `DELETE ... RETURNING` で先に消費し、署名検証・期限・手続き種別の確認に失敗しても元に戻さない。1回限りの状態である。

### `rate_limits`：ルームをまたぐ利用制限

| フィールド   | SQL型・制約          | 役割                                                          |
| ------------ | -------------------- | ------------------------------------------------------------- |
| `id`         | `TEXT`、必須、主キー | 対象・操作を含む制限キー。形式は下表のとおり                  |
| `count`      | `INTEGER`、必須      | 現在の時間枠で受け付けた回数。新規枠・期限切れ枠では1から開始 |
| `expires_at` | `INTEGER`、必須      | 現在の時間枠の終了時刻。期限内の加算では延長しない            |

| 制限キー                | 対象                                                       | 時間枠・上限                                     |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `ip:session:<hash(IP)>` | `POST /api/session`。送信者・受信者双方のセッション発行    | 1分20回                                          |
| `auth:rate:<hash(IP)>`  | パスキー登録・ログインの開始と検証。status・logoutは対象外 | 10分30回。開始と検証を別々に数える               |
| `auth:send:<accountId>` | 共有リンク作成時の `allowSend()`                           | 24時間30回。ルーム・セッションを変えても共有する |

時間枠は最初の加算から数える固定枠で、日付の切り替わりではリセットしない。IPは元の文字列ではなくSHA-256をキーに使う。送信制限キーのアカウントIDにはSQL外部キー制約を付けていない。

条件付きUPSERTで確認と加算を一度に行い、上限に達した有効な枠は更新せず拒否する。これは処理の受付回数であり、写真の転送完了数ではない。例えば `allowSend()` のあとで接続内の制限によりリンク作成が失敗しても、D1での加算は取り消さない。

### D1のインデックス

主キーに加え、次のインデックスを宣言している。

| インデックス          | 列                        | 用途                                 |
| --------------------- | ------------------------- | ------------------------------------ |
| `credentials_account` | `credentials(account_id)` | アカウントとの関連・連鎖削除を支える |
| `logins_account`      | `logins(account_id)`      | アカウントとの関連・連鎖削除を支える |
| `logins_expiry`       | `logins(expires_at)`      | 期限切れログインの削除               |
| `challenges_expiry`   | `challenges(expires_at)`  | 期限切れチャレンジの削除             |
| `rate_limits_expiry`  | `rate_limits(expires_at)` | 期限切れ制限レコードの削除           |

## ルームDOのKV

`session:`・`link:`・`photo:` のキーには、それぞれ別に発行したトークン全体のハッシュを付ける。`transfer:` は転送IDを直接付ける。KVの値はSQL行ではなく、文字列またはオブジェクトとして保存する。以下の「任意」は省略または `undefined` を許すフィールドであり、SQLのNULLとは区別する。

### 共通の値型

#### `Device`：接続者の情報

| フィールド | 型       | 役割                       |
| ---------- | -------- | -------------------------- |
| `id`       | `string` | 端末セッションID           |
| `name`     | `string` | セッションの表示名のコピー |

`Device` は端末を長期登録するテーブルではない。リンク参加者や転送状態に埋め込む、セッション時点の情報である。

#### `PhotoMeta`：写真のメタデータ

| フィールド | 型       | 役割                                                                                   |
| ---------- | -------- | -------------------------------------------------------------------------------------- |
| `id`       | `string` | 写真セット内で一意な写真ID                                                             |
| `name`     | `string` | ファイル名。1〜100文字で制御文字・パス区切りを許可しない                               |
| `type`     | `string` | MIMEタイプ。`image/jpeg`・`image/png`・`image/webp`・`image/heic`・`image/heif` を許可 |
| `size`     | `number` | 正の安全な整数で表すバイト数。画像変換時の受信サイズ照合にも使う                       |

1回の写真セットは1〜10枚、合計50MiB以下で、IDの重複を許可しない。HEIC/HEIF変換は別途1枚20MiBまで。`files` はリンク・転送・変換権限に複製し、独立した写真テーブルは作らない。

### `routing:room`：ルームの振り分け情報

値は16桁hexのルームIDの文字列。`issueSession()` が保存し、その後の共有トークン・写真変換トークンの先頭16桁に使う。通常のAPI経由ではWorkerが検証したルームIDを渡す。サービス単体では未指定時に空文字を保存する分岐もある。

この値には `expiresAt` がなく、現在の期限切れ掃除の対象にならない。

### `session:<hash(sessionToken)>`：端末セッション

値の型は `StoredSession = Omit<Session, 'token'> & { used?: boolean; authKey?: string }`。

| フィールド  | 型・任意性      | 役割                                                                                          |
| ----------- | --------------- | --------------------------------------------------------------------------------------------- |
| `id`        | `string`、必須  | 発行ごとのセッションUUID。WebSocketとの対応や送受信者の識別に使う                             |
| `name`      | `string`、必須  | 発行時のアカウント名。匿名なら `ゲスト <ID先頭4文字の大文字>`                                 |
| `room`      | `string`、任意  | 所属ルームID。通常のAPI経由では指定される                                                     |
| `expiresAt` | `number`、必須  | 発行から30分後のミリ秒Unix時刻                                                                |
| `used`      | `boolean`、任意 | 発行直後は未指定。WebSocketの認証成功時に `true` として保存し、同じトークンによる再認証を拒否 |
| `authKey`   | `string`、任意  | 発行時に有効なログインがあれば、その `logins.id`。匿名・無効なログインなら未指定              |

`token` 自体は保存値から取り除く。セッション発行時にログインを解決し、名前と `authKey` を保存する。後でログアウトしてもこの行は直ちに消えないが、リンク作成時には `authKey` をD1で確認し直す。1つのログインから作った複数の端末セッションは、異なる `id` とトークンを持つ。

### `link:<hash(linkToken)>`：共有リンク

値の型は `ShareLink`。

| フィールド     | 型・任意性                 | 役割                                                         |
| -------------- | -------------------------- | ------------------------------------------------------------ |
| `owner`        | `string`、必須             | 送信者の端末セッションID。接続中の送信者のWebSocketを探す    |
| `files`        | `PhotoMeta[]`、必須        | 送信予定の写真メタデータ                                     |
| `expiresAt`    | `number`、必須             | リンク作成から10分後                                         |
| `participants` | `GroupParticipant[]`、任意 | 未指定なら1対1。配列があればグループ配布で、作成直後は空配列 |

1対1では最初の受信者の参加時にリンクを削除し、個別の転送状態へ引き継ぐ。グループではリンクを保持し、最大5人の参加者を管理する。作り直し・取り消し・送信者切断・期限切れでもリンクを削除する。グループのリンク終了時は参加済みの待機・転送も終了する。

#### `GroupParticipant`：グループ配布の受信者と現在の試行

| フィールド | 型           | 役割                                            |
| ---------- | ------------ | ----------------------------------------------- |
| `id`       | `string`     | 現在の試行の転送ID。セッションIDではない        |
| `device`   | `Device`     | 受信者の端末セッションID・表示名                |
| `status`   | 下表の文字列 | 配布内での受信者の進行状態                      |
| `approved` | `boolean`    | 送信者が確認したか。初期値 `false`              |
| `accepted` | `boolean`    | 受信者が承諾したか。初期値 `false`              |
| `attempts` | `number`     | 初回を1とした試行回数。最大3回（初回と再送2回） |

| `status`       | 意味                                   |
| -------------- | -------------------------------------- |
| `waiting`      | 送信者確認または受信者承諾を待っている |
| `queued`       | 両方が揃い、先行転送の終了を待っている |
| `transferring` | この受信者への転送を開始した           |
| `complete`     | 受信者が転送完了を通知した             |
| `failed`       | 失敗・切断・タイムアウトで終了した     |
| `declined`     | 拒否またはキャンセルで終了した         |

送信者からの転送は1人ずつ進める。同じセッションIDの参加者が `failed` かつ3回未満の場合に再試行でき、参加者の値を新しい転送IDに差し替えて確認・承諾をやり直す。人数判定はアカウントや実端末ではなく `device.id` を使う。

人数・再送可否・承諾・結果の判定と参加者配列の更新は [domain/groups.ts](../backend/src/domain/groups.ts) の関数が担当する。更新関数は元の参加者を変更せず、新しい配列を返す。`RoomService` はDOの排他制御、更新結果の保存、通知、次の転送開始を担当する。

### `transfer:<transferId>`：送信者と受信者1人の転送

値の型は `TransferState`。

| フィールド  | 型・任意性          | 役割                                                                                                        |
| ----------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`        | `string`、必須      | 転送UUID。キーの末尾と同じ                                                                                  |
| `from`      | `Device`、必須      | 送信者のセッションID・表示名                                                                                |
| `to`        | `Device`、必須      | 受信者のセッションID・表示名                                                                                |
| `files`     | `PhotoMeta[]`、必須 | リンクから引き継ぐ写真メタデータ                                                                            |
| `started`   | `boolean`、必須     | 初期値 `false`。受信承諾と、グループの場合は送信者確認・順番待ちを経て開始時に `true`                       |
| `expiresAt` | `number`、必須      | 1対1は参加から2分後。開始時にその時点から10分後へ更新。グループはリンクの期限を引き継ぎ、開始時も延長しない |
| `groupKey`  | `string`、任意      | グループの場合の親 `link:<hash>`。1対1では未指定                                                            |

WebRTCのSDP・ICE candidateは相手へ中継するが、この値には保存しない。完了・拒否・キャンセル・失敗・切断・期限切れで転送レコードを削除し、参加者へ終了を通知する。完了の場合は受信者用の写真変換権限を発行する。永続的な転送履歴テーブルはない。

### `photo:<hash(photoToken)>`：受信後の写真変換権限

値の型は `PhotoGrant`。

| フィールド  | 型                       | 役割                                                                      |
| ----------- | ------------------------ | ------------------------------------------------------------------------- |
| `expiresAt` | `number`                 | 転送完了処理で権限を発行してから10分後                                    |
| `files`     | `PhotoMeta[]`            | 完了した転送の写真メタデータ。対象写真ID・HEIC/HEIF形式・サイズを確認する |
| `uses`      | `Record<string, number>` | `<photoId>:<mode>` ごとの利用回数。発行時は空オブジェクト                 |

例えば `uses = { "photo-1:preview": 1, "photo-1:jpeg": 2 }` は、写真 `photo-1` のプレビューを1回、JPEG変換を2回予約済みという意味。`mode` は `preview` / `jpeg` で、それぞれ最大3回。変換処理の前に予約・加算するため、変換に失敗しても回数は戻さない。

受信者へ通知する `PhotoAccess = { token, expiresAt }` はクライアント用の応答であり、KVに保存する `PhotoGrant` とは異なる。写真変換・破棄APIはBearerトークンでこの権限を参照する。WebSocket切断後も期限内の権限は残る。破棄APIまたは期限切れ掃除で削除する。

## WebSocket attachmentのフィールド

attachmentは `getWebSockets()` で取得した接続から読み出す状態で、KVの `storage.list()` には含まれない。接続を維持したHibernation後のイベント処理でも利用する。

| フィールド    | 型・任意性           | 役割                                                                                                                                                       |
| ------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectedAt` | `number`、必須       | 接続を受け入れたミリ秒Unix時刻。未認証のまま10秒を過ぎた接続の終了判定                                                                                     |
| `session`     | セッション情報、任意 | 認証成功後に保持。現在の書き込み内容は `{ id, name, expiresAt }`。型は `Omit<Session, 'token'>` なので `room` も任意で許すが、認証成功処理ではコピーしない |
| `authKey`     | `string`、任意       | セッションのログイン参照キー。リンク作成時のD1照会に渡す                                                                                                   |
| `linkKey`     | `string`、任意       | この接続が所有する現在の `link:<hash>`                                                                                                                     |
| `transfer`    | `string`、任意       | この接続に紐付く転送ID。グループの送信者には実際に送る1件、受信者には待機中から個別の転送を紐付ける                                                        |
| `window`      | `number`、任意       | メッセージ・要求カウンターの1分枠を開始した時刻                                                                                                            |
| `messages`    | `number`、任意       | 枠内の制御メッセージ数。240件を超えると接続終了                                                                                                            |
| `requests`    | `number`、任意       | 枠内のリンク作成・参加要求数。5件を超えると要求を拒否                                                                                                      |
| `turnCount`   | `number`、任意       | 接続中のICE設定取得の試行数。通常10回、`linkKey` がある接続は `participants × groupAttempts = 15` 回まで                                                   |

`window`・`messages`・`requests` は次のメッセージ到着時に必要に応じて枠を更新する。`turnCount` はこの1分枠ではリセットしない。いずれもD1の `rate_limits` とは別で、ルーム・接続をまたいで共有しない。

## 作成・更新・削除と保存期間

期限の到来による「利用不可」と、保存行・キーの「物理削除」は同時とは限らない。D1では読み取り・更新時、DOでは認証・リンク参加・転送操作・変換などの利用時にも期限を検査する。

| データ                        | 期限・失効                                              | 物理削除                                                                 |
| ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| D1 `accounts` / `credentials` | 自動期限なし。アカウントの無効化を確認                  | 定期削除なし。SQLでアカウントを削除した場合はcredential・loginを連鎖削除 |
| D1 `logins`                   | 発行から7日                                             | ログアウト・現在のログインの置き換え、または15分ごとのScheduled Handler  |
| D1 `challenges`               | 発行から5分、1回限り                                    | 検証で先に消費、新しい手続きで置き換え、またはScheduled Handler          |
| D1 `rate_limits`              | キーごとの時間枠                                        | Scheduled Handler。次の加算時には期限切れ枠を1件目として再利用もできる   |
| DO `routing:room`             | 期限なし                                                | 現在は削除しない                                                         |
| DO `session:*`                | 発行から30分、WebSocket認証は1回限り                    | Alarmで期限切れを削除。接続を閉じた時点ではセッションキーを削除しない    |
| DO `link:*`                   | 作成から10分、取り消し・作り直し・送信者切断でも失効    | 失効時。1対1では最初の参加時にも削除                                     |
| DO `transfer:*`               | 1対1は承諾待ち2分・開始後10分。グループはリンク期限まで | 完了・拒否・キャンセル・失敗・切断・Alarmによる期限切れ処理              |
| DO `photo:*`                  | 権限発行から10分                                        | 破棄APIまたはAlarm。接続終了・ログアウトだけでは削除しない               |

### DOのAlarmとルームの終了

セッション発行・WebSocket接続・リンク保存時に、必要なら15秒後のAlarmを予約する。Alarmは接続とKVを調べ、未認証・期限切れ接続を閉じ、期限切れデータを削除する。

- WebSocket接続があれば、次のAlarmを15秒後に予約する。
- 接続がなければ、保存値にある最も近い `expiresAt` を使い、少なくとも15秒後になるよう予約する。
- 接続も有効期限付きデータもなくなると、次のAlarmを予約しない。

`routing:room` は文字列で有効期限を持たないため、掃除の対象・次の期限の計算から外れる。現在のコードには `storage.deleteAll()` によるルーム全体の削除はなく、使い終えたDOにもこのキーが残る。DO自体の固定TTLも設けていない。

DOのメモリ上の実行インスタンスの休止・再生成と、ストレージの削除は別である。`RoomObject` は保持する `RoomService` にイベント処理を委譲し、サービスは同じDOのストレージと接続を使う。クラスのフィールドだけを永続状態として扱わず、KVとattachmentに保存する。Cloudflare側の動作は [DOのライフサイクル](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) と [ストレージの削除](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/#remove-a-durable-objects-storage) を参照。

### D1とDOをまたぐ変更の扱い

D1とDOの間にSQL外部キーや一括トランザクションはない。DOが `authKey` を保存したあとにD1のログインが失効・削除される場合があるため、送信認可では参照先を確認し直す。既存リンク・転送の有効期限はそれぞれ独立して管理し、ログアウトが全ルームの転送停止を意味するわけではない。

名前と写真メタデータは複数の保存値へコピーする。`name` はアカウントの現在値を参照する外部キーではなく、セッション発行時点の値である。`files` もIDで別ストアを引く仕組みではなく、リンク・転送・権限がそれぞれ持つ値である。

## 実装を確認する入口

| 内容                                                 | ファイル                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1のSQL定義・制約・インデックス                      | [backend/schema.sql](../backend/schema.sql)                                                                                                      |
| D1の読み書き・比較付き更新・原子的消費・期限切れ削除 | [d1-store.ts](../backend/src/infrastructure/d1-store.ts)                                                                                         |
| 認証・ログイン発行・アカウント単位の制限             | [application/auth.ts](../backend/src/application/auth.ts)                                                                                        |
| IP単位のセッション発行制限                           | [d1-auth.ts](../backend/src/infrastructure/d1-auth.ts)                                                                                           |
| D1の削除スケジュール・DOのbindingとSQLite設定        | [index.ts](../backend/src/index.ts)、[wrangler.jsonc](../backend/wrangler.jsonc)                                                                 |
| ルームの選択とDO名                                   | [api/routing.ts](../backend/src/api/routing.ts)、[api/app.ts](../backend/src/api/app.ts)、[gateway.ts](../backend/src/infrastructure/gateway.ts) |
| DOの入口・WebSocketと実行環境の接続                  | [room-object.ts](../backend/src/infrastructure/room-object.ts)                                                                                   |
| ルームのKV・attachment・転送進行・Alarm              | [application/room.ts](../backend/src/application/room.ts)                                                                                        |
| グループ参加者の状態更新・人数と再送の判定           | [domain/groups.ts](../backend/src/domain/groups.ts)                                                                                              |
| 写真変換権限のキーと保存・消費・失効                 | [application/photo-access.ts](../backend/src/application/photo-access.ts)、[domain/photos.ts](../backend/src/domain/photos.ts)                   |
| 共通データ型・枚数と容量・期限・グループの制限       | [shared/protocol.ts](../shared/protocol.ts)、[shared/photos.ts](../shared/photos.ts)                                                             |
| Cookie・トークンのキー生成                           | [api/http.ts](../backend/src/api/http.ts)、[domain/tokens.ts](../backend/src/domain/tokens.ts)                                                   |

フィールド・キー・制限・期限処理を変更する際は、この資料と上記の実装をあわせて更新する。D1のスキーマ変更手順は [宣言的なスキーマ管理](auth.md#宣言的なスキーマ管理) を参照。
