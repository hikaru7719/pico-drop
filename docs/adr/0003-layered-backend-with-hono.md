# ADR-0003: バックエンドをレイヤードアーキテクチャにし、API層にHonoを使う

- ステータス: 採用
- 決定日: 2026-10-18
- 2026-11-04追記: 認証・回数制限の永続化はD1へ変更し、旧DOデータの互換性は廃止。現在の構成と初回導入は [パスキー認証](../auth.md) を参照。
- 2026-11-04追記: DOのイベント受付と実行環境への接続を `RoomObject` に集約し、保持する `RoomService` へ業務処理を委譲する2クラス構成に整理。詳細は [データの概念スキーマとフィールド定義](../data-schema.md) を参照。
- 2026-11-04追記: グループ参加者の状態更新・人数と再送の判定を `domain/groups.ts` へ抽出。DOの排他制御・永続化・通知は `RoomService` に残す。認証HTTPは注入した `AuthService` を利用し、DO側は同サービスを直接利用する。

## 背景

認証・転送・画像変換のコードにHTTPの解釈、業務ルール、Cloudflareの操作が混在していた。APIの変更と業務ロジックの変更を分離し、Workers以外でもユースケースを検証できる構成にする。

## 決定

`backend/src/` を次の4層に分ける。

| 層               | ディレクトリ      | 責務                                                                                                                                               |
| ---------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| API              | `api/`            | Honoのルート、Origin・HTTPメソッドの検査、Cookie・Bearer・JSONの読み取り、HTTPレスポンスとエラーの変換                                             |
| アプリケーション | `application/`    | パスキー認証、セッション、共有リンク、グループ転送、写真変換の認可・上限・期限、回数制限と期限処理                                                 |
| ドメイン         | `domain/`         | アカウントと認証記録の型、トークン規則、写真変換権限と画像形式の判定                                                                               |
| インフラ         | `infrastructure/` | D1での認証永続化、Durable Objectsのライフサイクル・永続化・RPC、WebSocketの休止とアップグレード、Cloudflare Images・TURN・WebAuthnライブラリの接続 |

`index.ts` はHonoアプリとインフラ実装を組み立て、Workerと`RoomObject`をexportする構成の入口とする。

依存はAPI → アプリケーション → ドメインを基本とする。APIからドメインの入力処理用関数も参照できる。アプリケーションはストレージ、ソケット、認証検証、画像レンダラーなどのインターフェースに依存し、インフラ層が実装を渡す。インフラ層はDOのHTTP受付をAPI層に委譲するため、API層への依存も持つ。API層からインフラ層へのimportは禁止する。

アプリケーション・ドメインには`Request`・`Response`・Hono・Cloudflareの実行時APIを持ち込まない。Web StreamsやWeb Cryptoなどの標準APIは利用できる。WebAuthnのデータ構造と検証関数シグネチャは型として参照し、ライブラリの実行時importはインフラ層に置く。フロントエンドと共通の転送プロトコルは引き続き`shared/`に置く。

## APIと永続データの互換性

- 公開URL、HTTPメソッド、ステータスコード、Cookie属性、エラー文言、キャッシュ禁止、画像レスポンスの`nosniff`を維持する。予期しない例外は詳細を隠したキャッシュ不可のJSON 500レスポンスに統一する。
- ヘルスチェック以外ではOriginの検査を先に行う。認証・セッションのIP制限、認証チャレンジの原子的な消費・失効を維持する。
- Honoのワイルドカードは`/api/auth`自体にも一致するため、このパスは明示的に404とする。
- DOはWebSocket用の `RoomObject` とし、`HUB` bindingを維持する。認証・IP制限はD1の `DB` bindingを利用する。旧 `NearbyHub` はDO migrationで削除し、既存データを引き継がない。
- WebSocketの101レスポンスはラップせず返す。休止用attachment、接続数制限、`blockConcurrencyWhile`による排他、alarmの再スケジュールを維持する。
- JSONのサイズ・時間制限、画像サイズの厳密な照合、変換前後の期限検査を維持する。署名検証前には認証チャレンジを消費する。

## 検証

既存のテストを実装の隣へ移し、HTTP入口、セッション認証、ICEの認可、期限処理、外部サービスのアダプターを検証する。`architecture.test.ts`で層間importと内側の層へのHTTP・Cloudflare実行時APIの混入を検出する。

```sh
mise run test:coverage
mise run //backend:check
mise run lint
mise run format:check
mise run //backend:build
```

Workers実行環境でのパスキー認証・WebSocket・共有リンクは、開発サーバー起動後に既存の`backend/src/index.scenario.mjs`でも検証する。

## トレードオフ

小さなアダプターとインターフェースが増える一方、HTTPやCloudflareの設定なしに業務ロジックをテストできる。既存の転送状態機械は`RoomService`にまとめ、今回の変更では処理順や保存形式を変更しない。HTTPルーターを独自に保守する方式はやめ、Honoに統一する。

## 参考

- [Hono: App](https://hono.dev/docs/api/hono)
- [Hono: WebSocket Helper（レスポンスヘッダー変更の注意点）](https://hono.dev/docs/helpers/websocket)
