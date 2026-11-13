---
name: investigate-feedback
description: Discordで👎リアクションが付いた応答や過去のPiセッションにおけるボットの不適切な振る舞いを、保存された生コンテキストと実API再現から読み解く。ユーザーが「👎の原因を調べたい」「過去セッションでボットがおかしな返信をした理由を見たい」「生コンテキストを確認したい」「再現させたい」と求めたときに使う。
---

# 不適切なボット応答の経緯調査

このスキルは、過去のセッションや `👎` リアクション時に自動保存されたケースから、モデルに送信された生のコンテキストとツール実行の経緯を読み解き、人間に分かりやすく原因と改善案を報告するための手順を定める。

## 使うコマンド

すべての調査は `scripts/inspect-context.ts` 経由で行う。

1. `👎` 候補の一覧を取得する（外部 API 呼び出しなし）

```bash
bun run inspect:context cases
```

2. 通常の過去セッション一覧を取得する（外部 API 呼び出しなし）

```bash
bun run inspect:context sessions --limit 20
```

3. 候補またはセッションの生コンテキストと元ターンの経緯を表示する（外部 API 呼び出しなし）

`show` の出力には参考指標としてトークン内訳（`Token & Cache Reference`）や複数リクエスト時の Prefix Cache 一致率（`Prefix Cache Stability`）も含まれる。

```bash
bun run inspect:context show --case <caseId>
# 現在の SOUL.md やスキルでターン先頭から組み直した場合を見る
bun run inspect:context show --case <caseId> --mode turn-start
# 通常の過去セッションを指定ターンで見る（--turn -1 は最終ターン）
bun run inspect:context show --session <sessionId-or-path> --turn -1
# セッション全体のトークン推移や Prefix Cache の安定性を見る
bun run inspect:context show --session <sessionId-or-path> --all-turns --max-turns 5 --no-tools
# ツールスキーマが長すぎる場合は --no-tools、HTTP生JSONを見たい場合は --raw-payload を付ける
bun run inspect:context show --case <caseId> --no-tools --out /tmp/inspect.md
```

4. 実 API を使って再現させる、または LLM-as-a-Judge で補助評価する（外部 LLM API を呼び出す。`discord_send` は実送信されず記録のみ）

```bash
bun run inspect:context replay --case <caseId> --mode turn-start
bun run inspect:context replay --case <caseId> --mode pre-message
bun run inspect:context replay --session <sessionId-or-path> --turn -1 --provider <id> --model <id>
# 調査レポートに対して LLM-as-a-Judge による分析も実行する
bun run inspect:context show --case <caseId> --no-tools --judge
bun run inspect:context replay --case <caseId> --mode turn-start --judge --judge-provider <id> --judge-model <id>
```

## 調査の進め方

### 1. 対象の特定

ユーザーが特定の `caseId` やセッションを指定していない場合は、`bun run inspect:context cases`（および必要に応じて `sessions`）を実行し、候補一覧を提示して調べる対象を選ぶ。

### 2. 経緯と生コンテキストの精読

`show` の出力では次の順番で生の情報にあたり、どこに引きずられて不適切な応答になったかを特定する。

- `Token & Cache Reference`（および複数ターン・複数ステップ時の `Prefix Cache Stability`）で、System Prompt セクションやツール定義、会話履歴のトークン配分が膨らみすぎていないか、先頭プレフィックスが途中で崩れてキャッシュ効率を落としていないかを参考情報として確認する。
- `Recorded Turn Trace` で、ユーザーが実際に送った発言、`klein-turn-context` の内容、モデルが途中で呼んだツールと返り値、および `discord_send` 呼び出し直前の思考やテキストを読む。ツールが想定外の結果を返していないか、検索・読み込みを怠って推測で答えていないかを見る。
- `Transcript Messages Sent to Model` で、直前までの会話履歴・過去の完了ターン要約・別ユーザーの発言や `<event-metadata>` の並び順が、モデルに文脈や宛先を取り違えさせる形になっていないか確かめる。
- `System Prompt` と `Declared Tools` で、`SOUL.md`・スキル・ツール説明の間に相反する指示や誤解を招く表現がないか確かめる。

### 3. 現在の設定での変化確認と実 API 再現・Judge 補助

`show --mode turn-start` と `show --mode pre-message` を比べ、すでに `SOUL.md` やスキル修正が済んでいる箇所が原因なのか、今も同じ指示が渡っているのかを切り分ける。

現在のモデルで実際に振る舞いが変わるか確かめる必要があるときは `replay` を、生コンテキストに基づく第二意見が欲しいときは `--judge` を使う。`replay` と `--judge` は設定済みの実 API へ課金リクエストを送信するため、ユーザーからの明示的な指示がある場合、または実行前にユーザーの同意を得た場合のみ実行する。

## 人間への報告形式

調査結果は以下の観点に沿って、生コンテキストの該当部分を具体的に示しながら簡潔にまとめる。

1. 問題のターンで起きた事実（ユーザーの発言、途中ツール呼び出し、`👎` を受けた実際の発言）
2. 生コンテキスト上の原因（どの記憶・ルール・過去履歴・ツール結果・`SOUL.md` の記述がどの振る舞いを誘発したか）
3. 参考メトリクス・Judge 所見（トークン配分や Prefix Cache の崩れ、あるいは `--judge` を実行した場合の評価結果）
4. 実 API 再現の結果（実行した場合のみ、元の発言と再現結果の違い）
5. 修正案（`SOUL.md`、スキル、ツール説明、メモリ運用、`klein-turn-context` のどこを見直すべきか）
