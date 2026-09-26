# Oxlint の追加ルール

リポジトリで固定している Oxlint 1.85.0 の `--rules --format json` と公式ドキュメントを確認した。`eslint/` は Oxlint 内蔵実装の名前空間であり、ESLint パッケージの追加は不要。

| 要件                             | 設定・対応状況                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| if 文の `{}` を必須にする        | `eslint/curly: ["error", "all"]`。else・for・while などにも適用される。                                                                                                   |
| 1 関数10行以内                   | `eslint/max-lines-per-function` の `max: 10`。宣言・括弧・空行・コメントを含めて数える。即時実行関数も対象。                                                              |
| 引数4個以内                      | `eslint/max-params` の `max: 4`。超える場合は関連する値を引数オブジェクトにまとめる。オブジェクト化自体の強制や自動変換はしない。                                         |
| 数値・文字列を右辺にする         | `eslint/yoda: ["error", "never"]`。リテラルとの比較が対象で、定数識別子同士の順番は規定しない。                                                                           |
| ユニオン型の分岐は switch を使う | 使用を強制する内蔵ルールはない。`typescript/switch-exhaustiveness-check` は既に書かれた switch の網羅性を検査する別のルール。型情報を使う実行環境が必要で、今回は未追加。 |
| 文字列リテラルを定数化する       | 該当する内蔵ルールはない。`react/jsx-no-literals` は JSX 用であり、通常の TypeScript や Svelte の文字列定数化には使えない。                                               |
| オプショナル引数を極力使わない   | 該当する内蔵ルールはない。`oxc/no-optional-chaining` は `?.` の禁止であり、引数の `?` の禁止ではない。                                                                    |
| 不等号を `<` / `<=` に統一する   | 該当する内蔵ルールはない。`count > 0` を `0 < count` にするとリテラル右辺の方針と衝突するため、現設定では右辺配置を優先する。                                             |

未対応の要件はレビューで確認する。独自ルールや外部 ESLint プラグインは導入していない。既存の lint 対象・ファイル形式の範囲を引き継ぐため、この設定だけで Svelte テンプレート全体を検査できるわけではない。

導入時点の作業ツリーでは、追加前の lint は成功し、追加後は curly 141件、max-lines-per-function 66件、max-params 1件を検出した。既存コードの移行は未実施であり、`mise run lint` は移行が完了するまで失敗する。ルールの無効化や既存ファイルの除外による回避はしていない。

参考: [ルール一覧](https://oxc.rs/docs/guide/usage/linter/rules)、[curly](https://oxc.rs/docs/guide/usage/linter/rules/eslint/curly)、[max-lines-per-function](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-lines-per-function)、[max-params](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-params)、[yoda](https://oxc.rs/docs/guide/usage/linter/rules/eslint/yoda)、[switch-exhaustiveness-check](https://oxc.rs/docs/guide/usage/linter/rules/typescript/switch-exhaustiveness-check)。
