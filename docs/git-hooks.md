# Git hooks

`mise run setup` で、このリポジトリの Git hooks を有効にします。
既存のチェックアウトでは、次のコマンドだけでも有効にできます。

```sh
mise run hooks:install
```

コミット前に `.githooks/pre-commit` が次を順番に実行します。

1. `mise run //:format:check`
2. `mise run //:lint`

失敗するとコミットを中止します。チェック対象は `shared/` を含む通常のタスクと同じ範囲です。
ステージした内容だけでなく、作業ツリー全体を検査するため、未ステージの変更もチェック対象です。
自動修正や自動ステージは行いません。

整形違反がある場合は `mise run format` を実行し、差分を確認して必要なファイルをステージし直してください。
lint違反は修正後に `mise run lint` で確認してから再コミットしてください。

Gitを実行する環境のPATHに `mise` が必要です。GUIからコミットする場合も同様です。
設定はローカルの `core.hooksPath` に保存されるため、クローンごとにセットアップが必要です。
