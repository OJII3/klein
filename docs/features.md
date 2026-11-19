# 機能

この文書は Klein の機能を、設定と運用に必要な範囲で説明する。読者は Klein を運用する人と、機能を変更する開発者を想定する。導入手順は [README](../README.md) にある。

## セッション

セッションの履歴とローテーションの状態は `<runtime.agentDir>/sessions` と `<runtime.agentDir>/channel-sessions` に保存する。既存の `pi-durable` SQLite データベースは起動時に自動で移行する。

## Discord

- **アクセス制御** — `discord.access` が `config/config.jsonc` の `default` と `directMessages` を決め、`<runtime.agentDir>/discord-access.json` がギルド、チャンネル、スレッドの規則を保持する。規則はスレッド → チャンネル → ギルド → 既定の順に評価する。ボットの所有者は常にダイレクトメッセージを送れる。所有者のダイレクトメッセージは `directMessages` の設定にかかわらず所有者向けの機能を使う。`deny` のチャンネルやスレッドでメンションされると、Klein はその場所に保留中の通知を投稿し、所有者へ許可と拒否のボタン付きのダイレクトメッセージを送る。`owner` の場所は所有者専用なので、所有者以外がメンションしても要求は送らない。選択は `discord-access.json` に書き戻され、即座に反映される。保留中の要求は `<runtime.agentDir>/discord-access-requests.json` に保存されるため、再起動後もボタンは機能する。手作業の編集は起動時に読み込まれるので、ファイルを直接編集した後は Klein を再起動する。Discord の **Message Content Intent** が必要である。
- **コマンド** — `/status idle` はメッセージ処理を一時停止し、`/status online` は再開する (Manage Server 権限が必要)。`/channels` は現在のギルドでアクセス規則が明示的に許可しているチャンネルとスレッドを、解決後のレベル (`allow` または `owner`) とともに一覧する。
- **アクティビティ状態** — OpenCode Go、Google、Mistral の残りの予算使用量を表示し、1 時間ごとに更新する。

## LLM プロバイダー

- OpenCode Go (`opencode-go`)、Google Gemini (`google`、`GEMINI_API_KEY`)、Mistral (`mistral`、`MISTRAL_API_KEY`) に対応する。
- **Google と Mistral** — アクティビティ状態は当月の支出を表示する。支出は `USAGE_ENDPOINT` と `USAGE_TOKEN` が設定されていれば opencode-usage API から読み、設定がなければローカルのセッション使用量からの推定値を使う。
- **使用量の報告** — opencode-usage API が設定されている場合、Klein は完了した各プロバイダー要求のトークン数とコストを `POST <USAGE_ENDPOINT>` へ送る。これにより支出の合計は Klein と opencode の両方を対象とする。プロンプト、補完、ツール引数、ツール出力は送らない。
- **コンテキストウィンドウ** — `llm.contextWindowRatio` (`0.01`–`1.0`) が自動圧縮のためのコンテキスト使用量の上限を決める。`llm.compaction.backgroundTokens` は、ブロックを開始するしきい値より前にバックグラウンド圧縮を始めるトークン数を決める (既定値 `32768`。`0` ならブロックのしきい値で始める)。
- **画像解析** — `llm.image` が会話とは別の単発の視覚モデルを設定し、その解析結果を主な会話に加える。

## 音声チャットと TTS

- **音声チャット** — ローカルの Silero VAD (ONNX Runtime Web WASM) と WebSocket ASR を使う。詳細は [voice-chat-asr-protocol.md](voice-chat-asr-protocol.md) にある。
- **TTS** — `features.tts.serverUrl` で外部の Style-Bert-VITS2 サーバーを使う。`discord_voice` ツールと音声チャットの出力を提供する。詳細は [sbv2-tts-protocol.md](sbv2-tts-protocol.md) にある。
- **音声の相づち** — `features.voiceChat.reactions` は、回答を生成している間に短い相づちを再生する。プリセットは `bun apps/server/scripts/generate-voice-presets.ts [manifest-path]` で生成する。

## メモリ

共有メモリは、ギルド・チャンネル・スレッドの各スコープに置く長期記憶である。`features.sharedMemory.enabled` を有効にすると、Klein は最近の会話からギルドに永続する事実と好みを定期的に抽出し、バックグラウンドエージェントが read、write、edit ツールを使って `.runtime/memory` (`features.sharedMemory.directory` でも指定できる) の下のファイルを直接読み書きする。ギルド全体は `{guildId}/MEMORY.md`、チャンネルは `{guildId}/{channelId}/MEMORY.md`、スレッドは `{guildId}/{channelId}/{threadId}/MEMORY.md` に保存する。

各ファイルは `# MEMORY.md` と短い説明から始まり、`## Facts` と `## Preferences` の 2 節だけを持つ。各項目はメタデータを持たない 1 行の箇条書きで、日付が必要なら本文に含める。抽出は既定で会話のチャンネルを対象とし、事実がサーバー全体に当てはまる場合に限りギルドへ昇格させる。取得ではその場所に応じてギルド、チャンネル、スレッドのメモリをすべて加える。メモリ機能が有効なとき、旧 `{guildId}/MEMORY.json` は起動時に各スコープの Markdown へ移行し、`MEMORY.json.migrated` に改名する。

`features.userMemory.enabled` を有効にすると、Klein は Discord ユーザーごとに 1 つの Markdown ファイルを `<runtime.agentDir>/user-memory/{userId}.md` (`features.userMemory.directory` でも指定できる) に保つ。`{userId}` は Discord の数値ユーザー ID である。YAML フロントマターは `discord_id` (ユーザーが設定したユーザー名で、`@` より後の部分)、`display_name`、`nickname`、`first_name`、`last_name`、`summary`、`impression`、`updated_at` を保持する。`impression` は -100 から 100 までの整数で、0 が中立である。本文は Facts、History、In common、Strengthening の節からなる。Facts には確認済みの事実だけを書き、不明な値には `不明` を置く。誕生日や記念日のような日付は `- <key>: YYYY-MM-DD` の形で書く (例: `- birthday: 2000-01-02`)。Klein はユーザーからのメッセージを処理した時点でファイルを作り、会話がアイドルになった後に `features.userMemory.llm` (既定値は `llm`) のバックグラウンドエージェントが read、write、edit ツールでファイルを読み書きする。バックグラウンドエージェントは `display_name` と `impression` を変更しない。`user_memory_get` ツールはメッセージに表示される `@username` を受け取り、`<runtime.agentDir>/discord-users.json` を通して数値ユーザー ID に解決する。このファイルは Klein がメッセージで見たユーザーから作る共有の対応表であり、発言したか返信の著者として現れたユーザーだけを解決できる。会話の Pi セッションでユーザーが初めて発言したとき、Klein はそのユーザーのメモリをそのターンのコンテキストに加える。メモリにまだ内容がなければ、コンテキストは初対面であることを伝える。メモリの更新はバックグラウンドでのみ行い、ユーザーメモリを表示名で検索することはできない。

## スケジュール

リマインダーとウォッチは `<runtime.agentDir>/schedules` を共有する。各項目は Discord のチャンネルまたはスレッドに属し、セッションのローテーションをまたいで残る。配信は現在のアクセス規則と所有者 ID を再確認し、許可されなくなった項目は保存したまま配信しない。繰り返しの項目は再スケジュールし、1 回だけの項目はプロセスの残りの間スキップするため、拒否された項目を確認の間隔ごとに再確認することはない。

- **リマインダー** はチャンネルに付随タスクを 1 回または繰り返し (`every` 分、毎日、毎週) で開始し、`public` または `owner:<userId>` に限定する。タスクはリマインダーの文面を会話エージェントへ返し、会話エージェントがそれをどう発話するかを決める。
- **ウォッチ** は QuickJS スクリプトを繰り返し実行する。各確認は `wake()` でエージェントに通知するか `silent()` で何もしないかのどちらかで終わり、`store()` と `load()` が確認の間で JSON の値を保つ。確認は 30 秒でタイムアウトし、サンドボックスのメモリは最大 64 MiB、出力は 64 KiB に制限する。失敗は `watch_list` に記録され、エージェントを起こさない。`watch_add` は登録の前にスクリプトを 1 回実行し、`watch_update` で無効なウォッチを有効にすると有効化の前に 1 回実行する。この実行が失敗した場合、ウォッチは登録されず、または無効のままとなり、その実行での `store()` の書き込みは破棄される。`watch_update` はウォッチを編集し、`enabled: false` で無効にできる。無効なウォッチは設定を保つが確認されず、再有効化すると更新時刻から次の確認をスケジュールする。`watch_get` はスクリプトと引数を含む 1 つのウォッチを返す。ワーカーセッションから登録したウォッチはそのワーカーに属する。その wake はワーカーセッションを再開し、ワーカーの結果は `worker.result` イベントとして会話へ戻る。ワーカーが利用できない場合は、wake は代わりに会話へ送られる。

ウォッチのスクリプトは `args` 配列を読み、`watch` プロンプトの節に並ぶツールを `tools.<name>({ ...args })` で呼び、`text()` または `console.*` で出力する。この節はウォッチのツールカタログから描画され、`watch_add` が提供されている間だけ現れる。現在は `tools.fetch_content({ url, urls?, mode? })` を公開する。これはセッションの fetch ツールのうち読み取り専用で GET のみの部分集合である (`mode` は `raw` または `readable`。`auth`、`proxy`、`answer`、`extract`、動画は使えない)。

サンドボックスにはタイマー、ファイルシステム、プロセス API、永続ストレージがない (`store` と `load` は拒否される)。通常のセッションツールもウォッチのスクリプト内では使えない。出力されたテキストと返り値が結果を構成する。

スケジュールは統一された形式を使う。古い `<runtime.agentDir>/reminders` ディレクトリは無視される。

## 付随タスク

会話エージェントは `worker_start` で付随タスクを開始でき、リマインダーも発火時に付随タスクを開始する。タスクは独自の Pi セッションで走り、拡張、スキル、MCP サーバー、権限、画像解析、バックグラウンド圧縮は会話エージェントと同じだが、Discord の surface ツールは持たない。Discord へ書き込むことはなく、assistant text を `worker.result` イベントとして返す。発話するかどうかは会話エージェントが決める。`worker_send` はタスクへ追加の指示を渡し、`worker_close` はタスクを破棄し、`worker_list` は会話内のタスクを一覧する。ワーカーはウォッチを登録でき、ワーカーは自分のウォッチだけを見る一方、会話はチャンネル内のすべてのウォッチを一覧して管理できる。リマインダーのタスクは結果を届けた後に自身を閉じる。タスクのメタデータは `attached-tasks/` に保存されるため、再起動するとタスク一覧が復元され、次の `worker_send` が保存された Pi セッションを再開する。停止時に実行中だったプロンプトは `interrupted` と記され、自動では再実行されない。

## リモート MCP ツール

MCP ツールは Pi のエージェントディレクトリ (`.runtime/pi`) に登録する。

```sh
PI_CODING_AGENT_DIR=.runtime/pi bunx pi mcp add docs --url https://mcp.example.com/mcp --exposure deferred
```

401 を返すサーバーには、`bun run build:server` の後に認証する。

```sh
bun dist/klein mcp login docs
```

コールバックは `127.0.0.1` で受け付け、認証 URL を表示する。ブラウザが別のマシンで動いている場合は、リダイレクト後の URL を貼り付ける。資格情報は `<runtime.agentDir>/mcp-auth.json` に保存される。OAuth クライアントのリダイレクト URI が固定されている場合は、`mcp.json` に `oauth.callbackPort` または `oauth.callbackUrl` を設定する。MCP の設定を変えた後は Klein を再起動する。

## 所有者アクセス

場所とツールは `allow` と `deny` に加えて `owner` で制限できる。所有者向けの場所はボットの所有者だけを受け付け、分離されたセッション履歴を使い、共有メモリへ書き込まない。`owner` とされたツールと MCP サーバーは所有者の会話でのみ動く。

## Web UI

Pino のログ、Pi のセッション、メモリ、ツールの使用状況を見るための任意のダッシュボードである。ページのタイトルとヘッダーのブランドにはプロファイルのディレクトリ名を使う (`klein` は Klein、`yachiyo` は Yachiyo になる)。`config/config.jsonc` で有効にする。

```jsonc
{
  "features": {
    "webui": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 4310,
      "cloudflared": {
        "enabled": false,
      },
    },
  },
}
```

Klein を起動した後に `http://127.0.0.1:4310` を開く。

Pi のセッションは Discord のチャンネル名でラベル付けされる。Klein はメッセージを処理したときにチャンネルのセッション状態へ名前を記録し、起動時に既知のチャンネルを更新するため、ダッシュボードは要求ごとに Discord API を呼ばない。対応表は `GET /api/channels` からも取得できる。

**ツール** の画面は Pi のセッション履歴に保存されたすべてのツール実行を、ツールごとと MCP サーバーごとに数える。回数には codemode のスクリプトからの呼び出しを含み、Klein の再起動ではリセットされない。

**メモリ** の画面は共有メモリとユーザーメモリを一覧する。共有メモリはスコープごとの `MEMORY.md` を表示し、ファイル単位で編集・削除できる。ユーザーメモリは Klein がバックグラウンドで更新する Markdown ファイルから読み、削除できる。ユーザーの一覧は表示名、ユーザー名、数値ユーザー ID、概要で絞り込める。

フロントエンドの開発では、ボットを通常どおり動かしたまま Vite を別に起動する。

```sh
bun run dev:web
```

Vite は `http://127.0.0.1:5173` で UI を配信し、`/api` をポート 4310 へプロキシする。本番のビルドは `dist/web` に出力され、Elysia のアプリが配信する。

Cloudflare Tunnel で公開するには、`features.webui.cloudflared.enabled` を `true` にし、`TUNNEL_TOKEN` を `.env` に加え、Cloudflare Access で経路を保護する。`cloudflared` は Klein とともに起動し、停止する。トンネルが有効なのにトークンがない場合、Klein は起動を拒否する。
