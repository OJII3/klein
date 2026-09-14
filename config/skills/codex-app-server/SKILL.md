---
name: codex-app-server
description: Klein の Discord bot が、コード・プロンプト・skill の修正や小さなツール作成を、直接シェルを実行せず Codex app server に委譲するときに使う。
---

# Codex app server への委譲

Klein の `codex_projects`、`codex_delegate`、`codex_task_status` tool は、設定済みの Codex app server に実装作業を依頼するための tool 群。bot 自身の Pi セッションは会話と Discord への応答に集中し、ファイルの読み書きやテスト実行は app server 側の Codex に任せる。委譲は必ずバックグラウンドで実行され、完了・失敗・timeout は現在の Discord channel に通知される。

## 使う条件

- Klein 自身のコード、`config/SOUL.md`、skill、設定、テストを変更・修復したいとき
- Klein の workspace 内に小さなスクリプトやツールを作りたいとき
- 原因調査から実装、テストまでを一つの作業として委譲したいとき
- Codex が `config.toml` の `[projects."..."]` に保持している別プロジェクトを調査・変更したいとき

単なる説明、設計相談、Discord の読み書き、Codex project 外の操作には使わない。

## task の書き方

まず `codex_projects` で Codex の `config.toml` にある project 候補を取得し、対象が明確なら `codex_delegate` の `project` に返された path を渡す。対象を省略した場合は設定された default workspace を使う。これは app-server の project-list RPC ではなく、指定された `codexHome` のローカル設定を読む。

`codex_delegate` の `task` には、次の情報を自然文で含める。

1. 目的と背景
2. 変更してよい範囲。通常は選択した Codex project 内だけ
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

- `codex_projects` が返す Codex project の path だけを使う。ユーザー入力で socket や `codexHome` を変更しない
- app server の thread は `ephemeral`、`workspace-write`、`approvalPolicy=never` で開始する
- app server から approval や user input を求められた場合、Klein は自動承認せず拒否または空回答を返す
- 秘密情報の表示、Codex project 外の変更、削除・公開・push・デプロイは、依頼の必要性と明示的な許可がない限り行わない
- Codex の返却した summary だけで変更内容を断定しない。未完了、失敗、未検証の記載をそのまま伝える

## 返答の流れ

`codex_delegate` は受理結果を即時返す。通常の会話を継続し、受理した task id を必要に応じて伝える。Codex の turn が終了すると tool が直接 Discord に成功・失敗を通知する。必要なら `codex_task_status` で現在状態を確認する。成功時は変更内容と検証結果を短くまとめ、失敗時は原因と次に必要な情報を示す。ユーザーが追加修正を求めたら、新しい task に前回の summary と未解決事項を含めて再委譲する。
