# 自発的な発言

この文書は、Klein が会話の外で起きた出来事を自分から話題に出すための仕組みを説明する。読者は Klein の挙動を変える開発者と、設定を調整する運用者を想定する。

## 目的

Klein はチャンネルのメッセージに反応するだけではなく、監視や付随タスクの結果から得た出来事を、文脈に合うときに自分から発言する。ただし、通知の量とタイミングはユーザーの好みで制御でき、約束した追跡は必ず実体を持つ。

この機能は次の4つに分ける。

1. 好みの台帳
2. 約束の台帳
3. 配信ゲート
4. 候補のキュー

好みは「何を、いつ、どう聞きたいか」を保持する。約束は「あとで知らせる」と発言したことだけを保持し、監視の実体を必須にする。配信ゲートは好みと現在時刻から、すぐ話すか、次の発言に混ぜるか、まとめるか、黙るかを決める。候補のキューは、すぐに話さない出来事を届くまで保持する。

## 対象範囲

最初の実装では、自発的な発言を有効にするのは所有者のスコープに限る。所有者のダイレクトメッセージと、所有者専用のチャンネルが対象である。公開チャンネルでは既定で無効にし、チャンネル単位の好みと配信上限が揃ってから有効化する。

好みの変更は所有者だけができる。公開チャンネルで所有者以外が「この話題はいらない」と言っても、そのチャンネルの設定は変えない。

## 用語

- 好み (preference) は、ユーザーが明示した配信の指示である。話題、時間帯、届け方、表現を含む。
- 約束 (follow-up) は、Klein が「あとで知らせる」と発言した追跡である。監視、リマインダー、付随タスクのいずれかを実体として持つ。
- 候補 (signal) は、発言する価値があるかもしれない出来事である。監視の wake、付随タスクの結果、メモリの抽出、外部コネクタが作る。
- 配信 (delivery) は、候補を実際の発言につなげる判断である。

## ファイル

### 振る舞いの規範

`config/PROACTIVITY.md` を会話エージェントのシステムプロンプトに追加する。これはプロファイルに依存しない方針であり、git で管理する。プロファイルごとの性格は `config/<profile>/SOUL.md` に残す。

### 好みの台帳

`<runtime.agentDir>/proactive/preferences.md` に保存する。ファイルは人間が読める Markdown とし、更新は `proactive_preference_update` ツールだけが行う。エージェントに汎用の write ツールは渡さない。

```markdown
# Proactive preferences

## Delivery
- default: attach
- quiet_hours: 23:00-08:00
- digest_at: 09:00
- max_per_day: 3

## Topics
- weather: mute until 2026-12-01
- CI failure: allow urgent
- release: mute

## Notes
- 作業中は短く。リンクは求められたときだけ。
```

`Delivery` は配信ゲートが読む。`Topics` は話題ごとの許可、禁止、緊急時だけの許可を表す。`Notes` は自由文で、モデルが文脈として読む。パースできない行は無視し、ファイル全体は毎ターンのコンテキストに含める。ツールは既知の行だけを書き換え、他の行と節を保持する。

`until` を省略した話題の禁止は無期限とする。`mute` は `until` まで、または無期限に候補を保存だけにする。`urgent-only` は `now` の候補だけを通す。

### 約束の台帳

`<runtime.agentDir>/proactive/follow-ups/<id>.json` に1件1ファイルで保存する。スケジュールや付随タスクの保存形式に合わせ、書き込みは一時ファイルと rename を使う。

```ts
type FollowUpStatus = "active" | "notified" | "done" | "orphaned" | "expired" | "dismissed";

type FollowUpWatcher =
  | { kind: "watch"; id: string }
  | { kind: "reminder"; id: string }
  | { kind: "task"; id: string };

interface FollowUp {
  version: 1;
  id: string;
  channelId: string;
  accessScope: AccessScope;
  subject: string;
  watcher: FollowUpWatcher;
  cadenceLabel: string;
  status: FollowUpStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  lastNotifiedAt?: string;
  originMessageId?: string;
}
```

`follow_up_create` は watcher を必須にする。watcher が同じチャンネルとアクセススコープに存在しない場合は失敗する。成功時は `formatSchedule` の結果を `cadenceLabel` として返す。付随タスクの場合は「タスクの完了時」とする。

監視が削除された約束は `orphaned` にする。コンテキストを読むときに、監視、リマインダー、付随タスクの存在を確認して状態を更新する。一回だけのリマインダーが配信されたときは `done` にする。付随タスクの結果が届いたときも `done` にする。

### 候補のキュー

`<runtime.agentDir>/proactive/signals/<id>.json` に保存する。

```ts
type ProactiveUrgency = "now" | "today" | "digest" | "silent";
type ProactiveSignalStatus = "queued" | "surfaced" | "dismissed" | "expired";

interface ProactiveSignal {
  version: 1;
  id: string;
  channelId: string;
  accessScope: AccessScope;
  audience: "owner" | "public";
  source: { kind: "watch" | "worker" | "memory" | "connector"; ref?: string };
  topic: string;
  summary: string;
  evidence?: { url?: string; text?: string };
  urgency: ProactiveUrgency;
  dedupeKey: string;
  observedAt: string;
  expiresAt?: string;
  status: ProactiveSignalStatus;
  delivery?: {
    mode: "interrupt" | "attach" | "digest" | "silent";
    surfacedAt?: string;
    messageIds?: readonly string[];
  };
}
```

同じ `dedupeKey` の候補が `surfaced` または `dismissed` で存在する場合、新しい候補は作らない。`expiresAt` を過ぎた候補は `expired` にする。

## 配信ゲート

`decideDelivery` は純粋な関数とし、現在時刻、好み、チャンネルの種別、当日の配信数を入力にする。判断は決定的にする。

1. 公開チャンネルで機能が無効なら `silent`。
2. 話題が `mute` なら `silent`。`urgent-only` で `now` 以外なら `silent`。
3. 静かな時間で `now` 以外なら `attach`。`now` でも設定が許さなければ `attach`。
4. 当日の配信数が上限に達していて `now` 以外なら `attach`。
5. `now` は `interrupt`、`today` は `attach`、`digest` は `digest`、`silent` は `silent`。

`interrupt` は既存の watch wake と同じ経路で会話エージェントを起こす。`attach` は候補をキューに残し、次のユーザー発言のターンコンテキストに `<pending-signals>` として載せる。`digest` は指定時刻にまとめて1回の発言にする。`silent` は保存だけして発言しない。

`attach` と `digest` で一度コンテキストに載せた候補は `surfaced` にする。エージェントがその候補を話題にしなくても再通知しない。これは注意を奪わないための意図的な挙動である。

## ターンコンテキスト

会話エージェントには次のブロックを渡す。既存の `AgentTurnContext.blocks` を使い、システムプロンプトには入れない。

- `<proactive-preferences>` は所有者またはチャンネルの好み。長すぎる場合は `Delivery` と `Topics` を優先し、`Notes` を後ろに落とす。
- `<waiting-on>` はこのチャンネルの有効な約束。最大8件。
- `<pending-signals>` は `attach` 待ちの候補。最大5件。

watch の wake と付随タスクの結果を届けるときも同じブロックを付ける。

## ツール

すべて `features.proactivity.enabled` が真のときだけ会話エージェントに渡す。

- `proactive_preference_update` は好みを更新する。`set_delivery`、`set_topic`、`remove_topic`、`add_note` を受ける。所有者以外の呼び出しは拒否する。
- `follow_up_create` は監視、リマインダー、付随タスクを指定して約束を作る。watcher が見つからなければ失敗する。
- `follow_up_list` はこのチャンネルの有効な約束を返す。
- `follow_up_close` は約束を `done` または `dismissed` にする。
- `proactive_signal_list` はキューにある候補を返す。
- `proactive_signal_dismiss` は候補を `dismissed` にし、同じ `dedupeKey` の再通知を止める。

## 約束の監査

`discord_send` の送信前に、本文が追跡を約束しているように見えるかを調べる。約束の言い回しがあり、このチャンネルに有効な約束がない場合は、設定に応じて記録するか送信を止める。

設定は `off`、`log`、`block` の3つとする。既定は `log` にする。`block` は誤検知がクラインの言い回しを壊す可能性があるため、実際のログを見てから既定にする。

検出は日本語の限られた言い回しに対して行う。監視、確認、教える、知らせる、連絡する、報告するを含む文を対象にする。意味の判定ではなく、約束の登録漏れを見つけるための補助である。

## 設定

`config/config.jsonc` の `features.proactivity` で制御する。

```jsonc
{
  "features": {
    "proactivity": {
      "enabled": true,
      "preferencesFile": ".runtime/pi/proactive/preferences.md",
      "followUpDirectory": ".runtime/pi/proactive/follow-ups",
      "signalDirectory": ".runtime/pi/proactive/signals",
      "defaultMode": "attach",
      "quietHours": { "start": "23:00", "end": "08:00" },
      "digestAt": "09:00",
      "maxPerDay": 3,
      "publicChannels": false,
      "promiseGuard": "log"
    }
  }
}
```

`preferencesFile`、`followUpDirectory`、`signalDirectory` を省略した場合は `<runtime.agentDir>` の下の既定値を使う。`quietHours` と `digestAt` は設定の既定値であり、好みのファイルに値があればそちらを優先する。

## 実装の順序

### 第1段階: ドメインと保存

`apps/server/src/modules/proactivity` にドメイン、ポート、ファイル保存を追加する。アプリへの配線はしない。

- 好みのパース、描画、更新
- 約束の生成、状態遷移、期限切れ
- 候補の生成、重複判定、期限切れ
- 配信ゲートの純粋関数
- 3つのファイルストア

確認は `bun test apps/server/src/modules/proactivity` と `bun run typecheck` で行う。

### 第2段階: 設定、プロンプト、好みのツール

設定スキーマ、`ProactiveCoordinator`、`proactive_preference_update`、ターンコンテキストへの好みの描画を追加する。`config/PROACTIVITY.md` を読み、会話エージェントのシステムプロンプトに追加する。

確認は設定スキーマの生成、プロンプトの読み込み、好みの更新が次のターンに反映されること。

### 第3段階: 約束の台帳とツール

`follow_up_create`、`follow_up_list`、`follow_up_close` を追加する。監視の削除と一回だけのリマインダーの配信を状態に反映する。`<waiting-on>` をターンコンテキストに追加する。

確認は watcher なしの作成が失敗すること、監視を削除すると `orphaned` になること、一回だけのリマインダーが `done` になること。

### 第4段階: 配信ゲートと候補

watch の wake を候補に変換し、配信ゲートを通す。`attach` と `digest` のキュー、当日の配信数、重複排除、公開チャンネルの既定無効を実装する。`AgentCoordinator` にダイジェスト配信を追加する。

確認は固定時刻で静かな時間に発火した監視が翌朝まで待つこと、同じ候補が二重に届かないこと、公開チャンネルでは発言しないこと。

### 第5段階: 監査、文書、統合テスト

`discord_send` の約束監査、`docs/features.md` の更新、設定例、統合テストを追加する。`bun fmt`、`bun lint:fix`、`bun test`、`bun run typecheck` を通す。

## 対象外

- Web UI の候補一覧と好みの編集画面
- 外部サービスやデバイスのコネクタ
- 複数ユーザーの個人設定
- 目標管理

これらは、候補のキューと好みの台帳が動いてから別に設計する。
