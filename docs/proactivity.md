# 自発的な発言

この文書は、Klein が会話の外で起きた出来事を自分から話題に出すための仕組みを説明する。読者は Klein の挙動を変える開発者と、設定を調整する運用者を想定する。

Klein が自分で目標を定め、数時間後や翌日に実行する仕組みは [initiative.md](initiative.md) で設計している。この文書は、watch やワーカーの結果を配信する層を扱う。

## 目的

Klein はチャンネルのメッセージに反応するだけではなく、watch やワーカーの結果から得た出来事を、文脈に合うときに自分から発言する。ただし、通知の量とタイミングはユーザーの好みで制御でき、約束した追跡は必ず実体を持つ。

好みは「何を、いつ、どう聞きたいか」を保持する。約束は「あとで知らせる」と発言したことだけを保持し、watch の実体を必須にする。配信ゲートは好みと現在時刻から、すぐ話すか、次の発言に混ぜるか、まとめるか、黙るかを決める。候補のキューは、すぐに話さない出来事を届くまで保持する。

## 対象範囲

好みと自発的な発言の対象は会話のスコープで決める。

- 所有者のダイレクトメッセージと、所有者またはリンク済みユーザーのリンク済みチャンネルおよびスレッドはユーザー単位とする。同じユーザーの複数のリンク済みチャンネルで好みを共有する。
- 公開チャンネルはチャンネル単位とする。そのチャンネルで話す全員に同じ好みを使う。
- 公開チャンネルでは、ユーザーが明示的に登録した watch に由来する候補だけを既定で配信し、それ以外は保存だけにする。`publicChannels` で他の候補も有効化できる。

好みを変更できるのは、ユーザー単位のスコープではそのユーザー本人、公開チャンネルでは所有者だけとする。公開チャンネルで所有者以外が「この話題はいらない」と言っても、そのチャンネルの設定は変えない。

## 用語

- 好み (preference) は、ユーザーが明示した配信の指示である。話題、時間帯、届け方、表現を含む。
- 約束 (follow-up) は、Klein が「あとで知らせる」と発言した追跡である。watch、リマインダー、ワーカーのいずれかを実体として持つ。
- 候補 (signal) は、発言する価値があるかもしれない出来事である。watch の wake、ワーカーの結果、メモリの抽出、外部コネクタが作る。
- 配信 (delivery) は、候補を実際の発言につなげる判断である。

## ファイル

### 振る舞いの規範

`config/PROACTIVITY.md` を会話エージェントのシステムプロンプトに追加する。これはプロファイルに依存しない方針であり、git で管理する。プロファイルごとの性格は `config/<profile>/SOUL.md` に残す。

### 好みの台帳

`<runtime.agentDir>/proactive/preferences/<key>.md` に保存する。`<key>` はユーザー単位のスコープでは `user-<userId>`、公開チャンネルでは `channel-<channelId>` とする。以前の単一ファイル `proactive/preferences.md` は読み込まない。ファイルは人間が読める Markdown とし、更新は `proactive_preference_update` ツールだけが行う。エージェントに汎用の write ツールは渡さない。

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

`until` を省略した話題の禁止は無期限とする。ただし `proactive_preference_update` で無期限の `mute` を作るには `permanent: true` を明示する必要があり、省略すると一度の拒否を恒久化しないためのエラーになる。`mute` は `until` まで、または無期限に候補を保存だけにする。`urgent-only` は `now` の候補だけを通す。

### 約束の台帳

`<runtime.agentDir>/proactive/follow-ups/<id>.json` に1件1ファイルで保存する。スケジュールやワーカーの保存形式に合わせ、書き込みは一時ファイルと rename を使う。

形式は `FollowUp` 型にある。状態は次の意味を持つ。

- `active` は追跡中、`notified` は通知済みである。
- `done` は追跡が完了し、`dismissed` は取り下げられた。
- `orphaned` は追跡先の watch が削除された。
- `expired` は期限を過ぎた。

`follow_up_create` は watcher を必須にする。watcher が同じチャンネルとアクセススコープに存在しない場合は失敗する。成功時は `formatSchedule` の結果を `cadenceLabel` として返す。ワーカーの場合は「ワーカーの完了時」とする。

watch が削除された約束は `orphaned` にする。コンテキストを読むときに、watch、リマインダー、ワーカーの存在を確認して状態を更新する。一回だけのリマインダーが配信されたときは `done` にする。ワーカーの結果が届いたときも `done` にする。

### 候補のキュー

`<runtime.agentDir>/proactive/signals/<id>.json` に保存する。形式は `ProactiveSignal` 型にある。由来は watch、worker、memory、外部コネクタ、Goal を持てるが、現在候補を作るのは watch と Goal である。状態は `queued`、`surfaced`、`dismissed`、`expired` のいずれかである。

同じ `dedupeKey` の候補が `surfaced` または `dismissed` で存在する場合、新しい候補は作らない。`expiresAt` を過ぎた候補は `expired` にする。

## 配信ゲート

`decideDelivery` は純粋な関数とし、現在時刻、好み、チャンネルの種別、当日の配信数を入力にする。判断は決定的にする。

1. 公開チャンネルで機能が無効なら、watch 由来以外は `silent`。watch 由来は続ける。
2. 話題が `mute` なら `silent`。`urgent-only` で `now` 以外なら `silent`。
3. 静かな時間で `now` 以外なら `attach`。`now` でも設定が許さなければ `attach`。
4. 当日の配信数が上限に達していて `now` 以外なら `attach`。
5. `now` は `interrupt`、`today` は `attach`、`digest` は `digest`、`silent` は `silent`。

watch の `priority` が `urgent` のとき候補の urgency は `now`、`normal` のとき `today` になる。`urgent` はユーザーがすぐ知りたいと明示した watch だけに使い、通常の watch は `normal` にする。

`interrupt` は既存の watch wake と同じ経路で会話エージェントを起こす。`attach` は候補をキューに残し、次のユーザー発言のターンコンテキストに `<pending-signals>` として載せる。`digest` は指定時刻にまとめて1回の発言にする。`silent` は保存だけして発言しない。

ダイジェストは、その日の `digestAt` より前に観測した候補だけを対象にする。`digestAt` 以降に観測した候補は翌日のダイジェストまで待つため、同じ日のうちに何度もまとめが届くことはない。期限切れの候補は配信せず `expired` にする。

`attach` と `digest` で一度コンテキストに載せた候補は `surfaced` にする。エージェントがその候補を話題にしなくても再通知しない。これは注意を奪わないための意図的な挙動である。

## ターンコンテキスト

会話エージェントには次のブロックを渡す。既存の `AgentTurnContext.blocks` を使い、システムプロンプトには入れない。

- `<proactive-preferences>` はその会話のユーザーまたはチャンネルの好み。長すぎる場合は `Delivery` と `Topics` を優先し、`Notes` を後ろに落とす。
- `<waiting-on>` はこのチャンネルの有効な約束。最大8件。
- `<pending-signals>` は `attach` 待ちの候補。最大5件。

watch の wake とワーカーの結果を届けるときも同じブロックを付ける。

## ツール

すべて `features.proactivity.enabled` が真のときだけ会話エージェントに渡す。

- `proactive_preference_update` は好みを更新する。`set_delivery`、`set_topic`、`remove_topic`、`add_note` を受ける。ユーザー単位のスコープではそのユーザー本人、公開チャンネルでは所有者だけが呼べる。
- `follow_up_create` は watch、リマインダー、ワーカーを指定して約束を作る。
- `follow_up_list` はこのチャンネルの有効な約束を返す。
- `follow_up_close` は約束を `done` または `dismissed` にする。
- `proactive_signal_list` はこの会話のキューにある期限切れでない候補を返す。
- `proactive_signal_dismiss` は候補を `dismissed` にし、同じ `dedupeKey` の再通知を止める。

## 約束の監査

`discord_send` の送信前に、本文が追跡を約束しているように見えるかを調べる。約束の言い回しがあり、このチャンネルに有効な約束がない場合は、設定に応じて記録するか送信を止める。

設定は `off`、`log`、`block` の3つとする。既定は `log` である。`log` はチャンネルと本文の先頭120文字だけを記録し、全文は残さない。`block` は誤検知がクラインの言い回しを壊す可能性があるため、実際のログを見て誤検知が少ないと確認できたら選ぶ。

検出は日本語の限られた言い回しに対して行う。条件と報告の組 (見つけたら教える、変わったら知らせる、届いたら連絡する)、継続的な確認 (監視しておく、チェックしておく、確認しておく)、後日の報告 (後で教える、あとで報告する) を対象にする。有効な約束が1件でもあれば送信を許可する。意味の判定ではなく、約束の登録漏れを見つけるための補助である。

## Web UI

Web UI の「Proactivity」画面は `GET /api/proactivity` を読み、保留中の候補、約束、保存されている好みを表示する。候補は観測の新しい順に最大 200 件を返し、それを超える場合は最新のみであることを示す。候補は状態で絞り込め、根拠の本文と URL、由来、配信方法、期限を確認できる。約束は作成の新しい順、好みはファイルのキー順に並べる。画面は読み取り専用であり、好みの変更は引き続き `proactive_preference_update` ツールだけが行う。

## 設定

`config/config.jsonc` の `features.proactivity` で制御する。

```jsonc
{
  "features": {
    "proactivity": {
      "enabled": true,
      "preferencesDirectory": ".runtime/pi/proactive/preferences",
      "followUpDirectory": ".runtime/pi/proactive/follow-ups",
      "signalDirectory": ".runtime/pi/proactive/signals",
      "defaultMode": "attach",
      "quietHours": { "start": "23:00", "end": "08:00" },
      "digestAt": "09:00",
      "maxPerDay": 3,
      "publicChannels": false,
      "promiseGuard": "log",
    },
  },
}
```

`preferencesDirectory`、`followUpDirectory`、`signalDirectory` を省略した場合は `<runtime.agentDir>` の下の既定値を使う。`quietHours` と `digestAt` は設定の既定値であり、好みのファイルに値があればそちらを優先する。`promiseGuard` を省略した場合は `log` になる。

## 扱わない範囲

Web UI からの好みの編集と、外部サービスやデバイスのコネクタは扱わない。長期的な目標は [initiative.md](initiative.md) が扱う。
