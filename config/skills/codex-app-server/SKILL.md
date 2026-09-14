---
name: codex-app-server
description: Klein の Discord bot が、コード・プロンプト・skill の修正や小さなツール作成を、直接シェルを実行せず Codex app server に委譲するときに使う。
---

# Codex app server への委譲

Klein の `codex_delegate` tool は、設定済みの Codex app server に実装作業を依頼するための tool。bot 自身の Pi セッションは会話と Discord への応答に集中し、ファイルの読み書きやテスト実行は app server 側の Codex に任せる。

## 使う条件

- Klein 自身のコード、`config/SOUL.md`、skill、設定、テストを変更・修復したいとき
- Klein の workspace 内に小さなスクリプトやツールを作りたいとき
- 原因調査から実装、テストまでを一つの作業として委譲したいとき

単なる説明、設計相談、Discord の読み書き、workspace 外の操作には使わない。

## task の書き方

`codex_delegate` の `task` には、次の情報を自然文で含める。

1. 目的と背景
2. 変更してよい範囲。通常は設定された workspace 内だけ
3. 守るべき制約。既存の設計、公開 API、秘密情報、破壊的操作など
4. 完了条件。必要なテスト、lint、typecheck、動作確認
5. 最後に返してほしい報告。変更ファイル、確認したコマンド、未解決事項

Codex に具体的な shell command を強制する必要はない。目的と完了条件を渡し、適切な調査・編集・検証方法は Codex に選ばせる。

例:

```text
Klein の Discord bot に、設定済みの Codex app server へ作業を委譲する custom tool を追加したい。
この workspace の既存の agent/tool/config の構造に合わせて最小限に実装し、config で無効にした場合の既存動作は変えないこと。
TypeScript の型生成や Unix socket 接続の境界は型安全にし、接続失敗・キャンセル・タイムアウトも扱うこと。
変更後に関連テスト、typecheck、lint を実行し、変更ファイルと検証結果を報告して。
```

## 安全境界

- `codex_delegate` は設定された workspace と socket だけを使う。ユーザー入力で workspace や socket を変更しない
- app server の thread は `ephemeral`、`workspace-write`、`approvalPolicy=never` で開始する
- app server から approval や user input を求められた場合、Klein は自動承認せず拒否または空回答を返す
- 秘密情報の表示、workspace 外の変更、削除・公開・push・デプロイは、依頼の必要性と明示的な許可がない限り行わない
- Codex の返却した summary だけで変更内容を断定しない。未完了、失敗、未検証の記載をそのまま伝える

## 返答の流れ

委譲中は通常の会話を止めず、tool の結果を受け取ってから `discord_send` でユーザーに報告する。成功時は変更内容と検証結果を短くまとめ、失敗時は原因と次に必要な情報を示す。ユーザーが追加修正を求めたら、新しい task に前回の summary と未解決事項を含めて再委譲する。
