# systemd ユーザーサービス

この文書は、Linux 上で Klein を systemd のユーザーサービスとして常駐させる運用者に向けて、インストール、操作、更新の手順を説明する。設定項目は [features.md](features.md) にある。

## インストール

リポジトリで `bun install` と設定ファイル、`.env` の準備を済ませてから、次を実行する。

```sh
bun run systemd:install
```

このコマンドは `dist/klein` をビルドし、`~/.config/systemd/user/klein.service` を書いて、サービスを有効化して起動する。`XDG_CONFIG_HOME` が設定されている場合はそちらを使う。

すでに端末から `bun dist/klein` を起動している場合、二重起動を避けるためコマンドは停止する。表示された PID を `kill` で止めてから、もう一度実行する。

Nix がある環境では、unit は `nix develop --command bun dist/klein` で起動する。これにより flake の devShell が PATH に入り、`bwrap`、`pasta`、`cloudflared` をビルド時と同じ版で使える。Nix がない場合は `bun dist/klein` を直接起動するため、これらの実行ファイルを PATH に用意する必要がある。

## unit の構成

unit はリポジトリのルートを `WorkingDirectory` にし、`NODE_ENV=production` を設定する。Bun は起動時に `WorkingDirectory` の `.env` を読み、設定中の `.runtime/pi` のような相対パスもリポジトリのルートから解決する。

停止時は `SIGTERM` を送り、終了処理に最大 60 秒待つ。プロセスが異常終了した場合は 5 秒後に再起動する。正常終了した場合は再起動しない。

## 操作

サービスはユーザー単位で管理する。

```sh
systemctl --user status klein.service
systemctl --user start klein.service
systemctl --user stop klein.service
systemctl --user restart klein.service
```

ユーザーサービスは既定ではログイン中だけ動く。ログアウト後やマシン起動後も動かすには linger を有効にする。

```sh
sudo loginctl enable-linger $USER
```

インストール時に linger が無効であれば、このコマンドが案内される。

## ログ

標準出力と標準エラーは journald に送られる。

```sh
journalctl --user -u klein.service -f
journalctl --user -u klein.service --since today
```

Klein は pino のログを `<runtime.logDir>/pino` にも書く。

## 更新

コードを更新したら、ビルドと unit の再生成をまとめて行う。

```sh
git pull
bun install
bun run systemd:install
```

`bun run systemd:install` はビルドしてからサービスを再起動する。ビルドだけをやり直した場合は `systemctl --user restart klein.service` で反映できる。

## アンインストール

```sh
systemctl --user disable --now klein.service
rm ~/.config/systemd/user/klein.service
systemctl --user daemon-reload
```

## 注意

同じリポジトリでサービスと手元のプロセスを同時に動かさない。Discord のゲートウェイ接続が重複し、Web UI を有効にしていればポートも競合する。
