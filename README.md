# 🐕 OpenRyoko

Slackで空気を読んで働くAIゲートウェイ。必要なときだけ発言し、雑談には入らない。Claude Code / Codex / Gemini CLI を統合するデーモン型のアシスタント基盤です。

> OpenRyokoは [Jinn](https://github.com/hristo2612/jinn)（MIT License, by Hristo Stoyanov）をベースにした日本語ファーストの派生版です。

<p align="center">
  <img src="assets/ryoko-avatar.jpeg" alt="Ryoko" width="240" />
</p>

<p align="center">
  <img src="assets/jinn-showcase.gif" alt="OpenRyoko Web Dashboard" width="800" />
</p>

## 🐕 OpenRyokoとは

OpenRyokoは、Claude Code CLI / Codex SDK / Gemini CLI をひとつの常駐デーモンにまとめ、Slack等のチャンネルに「AI同僚」として配置できるゲートウェイです。OpenRyokoはバス（導管）であり、脳ではありません — 知能はラップするCLI側に任せ、OpenRyokoは「どこに流すか／誰に任せるか／いつ沈黙するか」を担当します。

### Jinn との違い（OpenRyoko独自の追加機能）

- **発言者認識**: SlackのユーザーIDからdisplay nameを解決し、operatorと混同しないように system prompt を組み立てる
- **空気読みトリアージ**: メッセージごとに軽量LLM（Haikuをデフォルト採用）で `silent / react / reply` を判定。メンションされない限り基本沈黙、自分が役に立てる話題にだけ介入
- **日本語デフォルト**: UI・CLI・設定テンプレートが日本語
- **`~/.ryoko` ホームディレクトリ**: 既存 `~/.jinn` からの自動マイグレーション付き

## 💡 なぜOpenRyokoか

### 🔑 Anthropic Maxサブスクリプションで動く

OpenRyokoはClaude Code CLIを子プロセスとして起動するため、Anthropicの公式クライアントとして扱われ、[月額$200のMaxサブスクリプション](https://www.anthropic.com/pricing)の枠内で動作します。APIトークン従量課金ではありません。

空気読みトリアージは軽量Haikuを使いますが、こちらもClaude Code CLI経由なのでMaxサブスクに含まれます（$0）。

### 🧠 「バス、脳ではない」哲学

OpenRyokoは独自のプロンプトエンジニアリング層を持ちません。Claude Codeが既にツール利用・ファイル編集・マルチステップ推論・記憶を担当しているので、OpenRyokoはそれを外の世界（Slack、cron、WebUI）に接続するだけ。Claude Codeが進化すれば、OpenRyokoも自動的に強くなります。

### 🐕 空気読み能力

「うざくならず、必要な時には出てくる」を守るため、Slackメッセージは受信時に以下のフローで判定されます：

```
受信メッセージ
  ├─ DM？               ──→ 常に返信
  ├─ @メンション？       ──→ 常に返信
  └─ グレーゾーン        ──→ 軽量LLM（Haiku）でトリアージ
                             ├─ silent → 何もしない
                             ├─ react  → 絵文字スタンプだけ付ける
                             └─ reply  → 本エンジンで返信
```

判定基準（デフォルトプロンプトより）:
- 明らかに自分宛 → reply
- 自分の専門領域で役に立てる → reply
- 単なる同意・感謝 → react（絵文字のみ）
- それ以外 → silent（雑談には絶対に割り込まない）

確信度 60% 未満なら silent に倒す保守的設計です。

## ✨ 主要機能

- 🔌 **3エンジン対応** — Claude Code CLI + Codex SDK + Gemini CLI
- 💬 **コネクタ** — Slack（スレッド・リアクション・空気読み）、WhatsApp、Discord、Telegram
- 🎯 **自然言語 `/goal`** — 「最後までやって」「完成するまで止まらないで」等の Slack 発言を検出し、Claude Code v2.1.139+ の `/goal` Stop hookを自動起動。複数ターンの作業結果はそれぞれ独立した Slack メッセージとして届く
- 🖼️ **Agents View Canvas** — 現在動いている全 Ryoko セッションを Slack の Canvas にライブ同期。チャンネルのタブから「いま何が走っているか」がひと目で分かる
- 📎 **ファイル添付** — Web チャットにドラッグ&ドロップしたファイルをエンジンへパススルー
- 📱 **モバイル対応** — サイドバー折りたたみ・モバイル向けダッシュボード
- ⏰ **Cron スケジューリング** — ホットリロード対応のバックグラウンドジョブ
- 👥 **AI組織システム** — 部門・階級・マネージャー・従業員・タスクボード
- 🌐 **Web ダッシュボード** — チャット、組織図、カンバン、コスト追跡、cron可視化
- 🔄 **ホットリロード** — config、cron、組織ファイルを再起動なしで反映
- 🛠️ **自己改変** — エージェントが自分の設定・スキル・組織を実行中に編集可能
- 📦 **スキルシステム** — エンジンがネイティブに従う再利用可能なMarkdownプレイブック
- 🏢 **マルチインスタンス** — 複数のOpenRyokoインスタンスを並列起動
- 🔗 **MCP対応** — 任意のMCPサーバーに接続

## 🚀 クイックスタート

### npm で入れる（推奨）

```bash
npm install -g openryoko
ryoko setup
ryoko start
```

アップデートは `ryoko update`。

### ソースから入れる（開発・改造向け）

```bash
git clone https://github.com/rsensui2/OpenRyoko.git
cd OpenRyoko
pnpm install
pnpm build
npm install -g ./packages/jimmy

ryoko setup
ryoko start
```

ブラウザで [http://localhost:7777](http://localhost:7777) を開くとダッシュボードが表示されます。

## 🏗️ アーキテクチャ

```
                          +----------------+
                          |   ryoko CLI    |
                          +-------+--------+
                                  |
                          +-------v--------+
                          |   ゲートウェイ  |
                          |    デーモン     |
                          +--+--+--+--+---+
                             |  |  |  |
              +--------------+  |  |  +--------------+
              |                 |  |                  |
      +-------v-------+ +------v------+  +-----------v---+
      |    エンジン    | |  コネクタ    |  |    Web UI     |
      |Claude|Codex|Gem| | Slack|WA|DC |  | localhost:7777|
      +----------------+ +-------------+  +---------------+
              |                 |
      +-------v-------+ +------v------+
      |     Cron      | |   組織       |
      | スケジューラ    | |  システム     |
      +---------------+ +-------------+
```

CLI がゲートウェイデーモンにコマンドを送信。デーモンがAIエンジンへ作業を振り分け、コネクタ統合を管理し、cron ジョブを実行し、Web ダッシュボードを配信します。

## ⚙️ 設定

OpenRyokoは `~/.ryoko/config.yaml` から設定を読み込みます（`~/.jinn/` が既存の場合、初回起動時に自動マイグレーション）。

```yaml
gateway:
  port: 7777

engines:
  claude:
    enabled: true
  codex:
    enabled: false

connectors:
  slack:
    app_token: xapp-...
    bot_token: xoxb-...
    # 空気読みトリアージ（メンションなしメッセージへの過剰反応を抑制）
    triage:
      enabled: true
      model: claude-haiku-4-5
      timeoutMs: 20000
      threadContextLimit: 10

cron:
  jobs:
    - name: daily-review
      schedule: "0 9 * * *"
      task: "PRをレビューして要約を投稿"

portal:
  portalName: Ryoko
  operatorName: 亮介
  language: Japanese

org:
  agents:
    - name: reviewer
      role: code-review
```

## 📁 プロジェクト構成

```
OpenRyoko/
  packages/
    jimmy/          # ゲートウェイデーモン + CLI（パッケージ名: openryoko）
    web/            # Web ダッシュボード（パッケージ名: @openryoko/web）
  turbo.json
  pnpm-workspace.yaml
```

## 🧑‍💻 開発

```bash
git clone https://github.com/rsensui2/OpenRyoko.git
cd OpenRyoko
pnpm install
pnpm setup   # 一回限り: 全パッケージビルド + ~/.ryoko 作成
pnpm dev     # ゲートウェイ + Next.js dev サーバーをホットリロードで起動
```

[http://localhost:3000](http://localhost:3000) で Web ダッシュボードが開けます。

> **前提条件:** Node.js 22+、pnpm 10+、[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`npm install -g @anthropic-ai/claude-code`）

### 主要スクリプト

| コマンド | 説明 |
| --- | --- |
| `pnpm setup` | 全パッケージビルド + `~/.ryoko` 初期化（一回限り） |
| `pnpm dev` | ゲートウェイ（`:7777`）と Next.js dev サーバー（`:3000`）をホットリロードで起動 |
| `pnpm start` | クリーンビルド後にゲートウェイを `:7777` で起動 |
| `pnpm stop` | 稼働中のゲートウェイデーモンを停止 |
| `pnpm status` | ゲートウェイの稼働状態を確認 |
| `pnpm build` | 全パッケージをビルド |
| `pnpm typecheck` | TypeScript 型チェックを実行 |
| `pnpm lint` | 全パッケージを lint |
| `pnpm clean` | ビルド成果物を削除 |

## 🖥️ Linux サーバーで常駐させる（systemd）

VPS等で 24/7 稼働させたい場合、`scripts/systemd/` に systemd unit テンプレートと
インストーラを用意しています。これを使えば「`spawn claude ENOENT`」「rootだとClaude
CLIに弾かれる」「クラッシュ後に手動で立ち上げ直し」といったお決まりの落とし穴を
回避できます。

```bash
# 1. 専用ユーザーを作成（rootで動かさない）
sudo useradd -m -s /bin/bash ryoko

# 2. その ryoko ユーザーで Node 22+ と OpenRyoko をインストール
sudo -u ryoko -i bash -lc '
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  source ~/.nvm/nvm.sh
  nvm install 22
  npm install -g openryoko @anthropic-ai/claude-code
  ryoko setup
'

# 3. systemd unit を /etc/systemd/system/ に配置して enable
sudo ./scripts/systemd/install.sh ryoko

# 4. ログ追跡
journalctl -u openryoko -f
```

`install.sh` は対象ユーザーの PATH（nvm の Node ディレクトリ含む）を自動検出して
unit ファイルに焼き込みます。手動で `openryoko.service` をコピーする場合は、
テンプレート先頭のコメント（User / WorkingDirectory / Environment=PATH=… /
ExecStart）を必ず編集してください。

> **rootで動かしたい場合**: 非推奨ですが、OpenRyoko が `IS_SANDBOX=1` を自動付与
> するので Claude CLI の root 拒否はバイパスされます。それでも専用ユーザー運用を強く推奨します。

## ⚙️ Web UI からの設定変更

ダッシュボードの Settings 画面で Slack トークン等を保存すると、`~/.ryoko/config.yaml`
が更新されたあと自動でコネクタが再接続されます（v0.9.5 以降）。デーモン再起動は
不要です。手動で再接続したい場合は `POST /api/connectors/reload` を叩けます。

## 🎯 自然言語 `/goal` — 自律完遂タスク

Claude Code v2.1.139+ で追加された `/goal` コマンドを、Slackの自然な日本語/英語から
自動起動できます。

例えば DM や @メンションで：

> 5社の人事SaaSの料金/機能を比較した表をこのスレッドに投げて、**最後までやって**

と頼むと、OpenRyoko は内部で Haiku を呼んで完了条件を一文に蒸留し、Claude Code への
プロンプトに `/goal X` を前置します。Claude は `/goal` の Stop hook を立て、**条件が
満たされるまで複数ターンに渡って自律的に作業**を続けます。各ターンの応答はそれぞれ
独立した Slack メッセージとして投稿されるので、進捗が見える形で届きます。

トリガーは決定論的なフレーズ（「最後まで」「止まらないで」「完成するまで」「終わったら
教えて」「keep going」「until done」等）に加え、文中に **埋め込まれた停止条件**
（「完了と書いたら止まる」「Xになるまで」「別々のターンで」等）にも反応します。
意味判定は Haiku が行うので、対応フレーズを覚える必要はありません。

> 💡 Claude Code は **v2.1.139 以降が必須** です（古いバージョンだと `/goal isn't available
> in this environment` になります）。`npm install -g @anthropic-ai/claude-code@latest`
> で最新化してください。

## 🖼️ Agents View Canvas — Slack でいつでも状況把握

設定で有効化すると、Ryoko は指定した Slack チャンネルに **「Ryoko Agents View」**
というタブ付き Canvas を自動作成し、現在動いている全セッションを30秒ごとに更新
します。Running / Waiting / Errored / Interrupted / Idle のグループに分かれて、
チャンネル上部のタブから即座に「いま何が走っているか」が把握できます。

### 有効化手順

1. **Slack App に scope を追加** — Settings ページの「Slack App Manifest」ブロックを
   コピーして自分の Slack App に貼り直し、Reinstall to Workspace を実行。これで
   `canvases:write` / `canvases:read` を含む必要 scope がすべて揃います
2. **Settings → Slack → Agents View Canvas** で：
   - 「有効化」をON
   - 「表示先チャンネル」のドロップダウンから対象チャンネル選択（Bot が member の
     channel のみ表示されます）
   - 必要に応じてタイトル・更新間隔・表示件数を調整
3. 保存すると30秒以内に指定チャンネルに Canvas が出現します

設定はホットリロード対応なので、デーモン再起動は不要です。

## 🔗 Jinn からの移行

既に `~/.jinn/` で Jinn を運用している場合、OpenRyoko は初回起動時に自動でディレクトリを `~/.ryoko/` にリネームします。トークン・セッション履歴・スキル・組織ファイルはすべてそのまま引き継がれます。

環境変数で古い設定を尊重することもできます：

- `JINN_HOME` — 指定パスをホームとして使用（後方互換）
- `JINN_INSTANCE` — インスタンス名指定（後方互換）
- `RYOKO_HOME` / `RYOKO_INSTANCE` — 新推奨

## 📄 ライセンス

[MIT](LICENSE)

元の著作権表記（Jimmy AI Contributors / Hristo Stoyanov）は `LICENSE` ファイルに保持されています。OpenRyoko の追加変更も同じく MIT ライセンスで提供されます。

## 🙏 謝辞

- 本体の 95% は [Jinn](https://github.com/hristo2612/jinn) のコードそのものです。素晴らしい基盤を公開してくれた Hristo Stoyanov 氏に感謝します
- Web ダッシュボードのUIコンポーネントは [ClawPort UI](https://github.com/JohnRiceML/clawport-ui) by John Rice を基礎にしています

## 🤝 コントリビュート

本リポジトリは現在、個人利用に合わせた日本語ファーストの実験的派生版です。上流 Jinn に還元できる汎用的な改善は積極的に PR を送る方針です。
