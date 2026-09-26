# Oxlint の追加ルール

リポジトリで固定している Oxlint 1.85.0 の `--rules --format json` と公式ドキュメントを確認した。`eslint/` は Oxlint 内蔵実装の名前空間であり、ESLint パッケージの追加は不要。

| 要件                             | 設定・対応状況                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| if 文の `{}` を必須にする        | `eslint/curly: ["error", "all"]`。else・for・while などにも適用される。                                                                                                    |
| 1 関数10行以内                   | `eslint/max-lines-per-function` の `max: 10`。宣言・括弧・空行・コメントを含めて数える。即時実行関数も対象。                                                               |
| 引数4個以内                      | `eslint/max-params` の `max: 4`。超える場合は関連する値を引数オブジェクトにまとめる。オブジェクト化自体の強制や自動変換はしない。                                          |
| 数値・文字列を右辺にする         | `eslint/yoda: ["error", "never"]`。リテラルとの比較が対象で、定数識別子同士の順番は規定しない。                                                                            |
| ユニオン型の分岐は switch を使う | 使用を強制する内蔵ルールはない。`typescript/switch-exhaustiveness-check` は既に書かれた switch の網羅性を検査する別のルール。型情報付き lint と併せて error として有効化。 |
| 文字列リテラルを定数化する       | 該当する内蔵ルールはない。`react/jsx-no-literals` は JSX 用であり、通常の TypeScript や Svelte の文字列定数化には使えない。                                                |
| オプショナル引数を極力使わない   | 該当する内蔵ルールはない。`oxc/no-optional-chaining` は `?.` の禁止であり、引数の `?` の禁止ではない。                                                                     |
| 不等号を `<` / `<=` に統一する   | 該当する内蔵ルールはない。`count > 0` を `0 < count` にするとリテラル右辺の方針と衝突するため、現設定では右辺配置を優先する。                                              |

未対応の要件はレビューで確認する。独自ルールや外部 ESLint プラグインは導入していない。既存の lint 対象・ファイル形式の範囲を引き継ぐため、この設定だけで Svelte テンプレート全体を検査できるわけではない。

既存コードはルールに合わせて移行済み。`sendPhotos` は引数オブジェクトを受け取り、認証・位置取得・写真検証・転送・画面の状態更新を小さな関数に分割している。テストもシナリオと検証の補助関数に分割し、上限の緩和やファイル除外はしていない。

`mise run lint` と `mise run lint:fix` は `--type-aware` で実行する。設定にも `options.typeAware: true` を指定し、CLI以外でも型情報付き lint を有効にする。実行エンジンは開発依存の `oxlint-tsgolint`（固定バージョン）で、`pnpm install --frozen-lockfile` または `mise run setup` により導入される。既存の correctness カテゴリに属する型情報付きルールと `typescript/switch-exhaustiveness-check` が実行される。

型検査自体は従来どおり `mise run check` で実行する。Svelte の型検査は svelte-check が担当する。型情報付き lint の有効化によって、Svelte テンプレート全体に TypeScript の lint が適用されるわけではない。

検証: 型情報付き lint、型検査、ユニットテスト、APIテスト、2ブラウザ間のWebRTC転送テスト。型情報を必要とする診断が frontend/backend/shared/tests の TypeScript ファイルで実際に動くことも、一時的な違反例を使って確認した。

参考: [ルール一覧](https://oxc.rs/docs/guide/usage/linter/rules)、[curly](https://oxc.rs/docs/guide/usage/linter/rules/eslint/curly)、[max-lines-per-function](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-lines-per-function)、[max-params](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-params)、[yoda](https://oxc.rs/docs/guide/usage/linter/rules/eslint/yoda)、[switch-exhaustiveness-check](https://oxc.rs/docs/guide/usage/linter/rules/typescript/switch-exhaustiveness-check)。
