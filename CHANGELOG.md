# Changelog

> **バージョン体系について**: 2026.4.26 から日付ベース (`YYYY.M.D`) のCalVerに移行しました。npm semver の制約上、月・日の leading zero は付けません (例: 4月26日 → `2026.4.26`)。

## [2026.7.2] - 2026-07-02

### Fixes（インタラクティブエンジンの耐障害性 — 「server error で失敗」「返事が返ってこないまま終わる」対策）
- **Anthropic サーバーエラー (5xx/529) の自動リトライ**: `Interactive turn failed: server_error`（CLI が数分の内部リトライ後に諦めたケース）でターンを即エラー確定せず、バックオフ付き（既定 30s→2m→5m、`sessions.transientRetryDelaysMs` で調整可）で**同一エンジンセッションを resume して続行**するように。Slack には自動リトライ中である旨を一度だけ通知。障害が続いた場合のみ従来どおりエラーを報告。
- **バックグラウンド完了の配送（孤児 Stop フック）**: ターン確定後にサブエージェント／バックグラウンドタスクが完走して発火する Stop フックは、従来 30 秒バッファ後に**破棄**され、最終成果がどこにも届かなかった。孤児 Stop をセッションの会話（Slack スレッド等）へ配送し、親セッションにも完了通知（`notifyParentSession`）するように。`sessions.backgroundDelivery: false` で無効化可。あわせて、古い Stop が次ターンのリゾルバに流れ込み**前ターンのメッセージで即確定してしまう**バッファ競合も解消（terminal な孤児はバッファしない）。
- **作業中 PTY の保護**: keep-warm リーパー（ターン終了 10 分後に SIGTERM）と LRU 追い出しが、バックグラウンド作業中の PTY を殺して作業を無音で打ち切っていた。SSE プロキシの in-flight リクエスト／直近アクティビティと孤児フック受信を生存シグナルとして、**実際に動いている PTY は回収しない**ように。
- **ターン watchdog の誤爆防止**: 90 分のターン上限（`interactiveTurnTimeoutMs`）は「ハングしたターン」検出のためのものだが、長時間の正当な自律バッチも殺していた。エンジンが実際に活動中（API リクエストが流れている）の間はタイムアウトを発火しないように（真にハングした PTY は活動が止まるため従来どおり回収される）。

### Tests
- jimmy: 534 tests pass（孤児フックの配送/バッファ挙動、busy PTY の reaper/LRU 保護、`touch()` の grace 更新、SSE プロキシ in-flight 追跡、`isTransientServerError` 判定の回帰テストを追加）。

## [2026.7.1] - 2026-07-01

### Features
- **Claude Sonnet 5 対応**: `sonnet` エイリアスが解決する新モデル `claude-sonnet-5` をコスト推定表（headless / interactive 両方）と設定画面のモデル表記に追加。コンテキスト窓は既存の `sonnet` パターン一致で 1M に解決。
- **Claude の effort デフォルトを `xhigh` に**: Sonnet 5 / Opus 4.7・4.8 が対応した `xhigh` を標準化。設定画面の Effort Level に「Extra High」を追加。合成レジストリはモデル能力に応じて `xhigh` の可否を判定し（Opus 4.7+ / Sonnet 5 のみ）、Haiku や旧 Opus/Sonnet では `resolveEffort` が安全に `medium` へクランプ。
- **決定論的 config パッチ機構**: マイグレーションに `config-patch.json` を同梱すると、`ryoko update`（`ryoko migrate --auto`）が config.yaml のデフォルト値を**ユーザーのカスタマイズを壊さずに**追従更新（未設定→挿入 / 旧デフォルト一致→更新 / カスタム済み→スキップ、冪等）。2026.7.1 では `engines.claude.effortLevel: medium → xhigh` を適用。

### Fixes
- **interactive Claude のコスト計上**: エイリアス（`sonnet` 等）ではなくトランスクリプトの実モデルID（`claude-sonnet-5` 等）で料金を解決するようにし、Sonnet/Haiku が Opus 価格で過大計上される問題を修正。

### Tests
- jimmy: 521 tests pass（config パッチのセマンティクス・冪等・カスタム保護、出荷 patch の妥当性検証、モデル別 effort 能力判定の回帰テストを追加）。

## [2026.6.5] - 2026-06-03

### Features
- **設定画面に「インタラクティブPTY（Max定額）」トグル**: ダッシュボードの「エンジン設定」から `engines.claude.interactive` を確認・切替できるように（CLI を使わずに済む）。保存後はゲートウェイ再起動で反映。
- **Claude Opus 4.8 対応**: `opus` エイリアスは Claude CLI が最新 Opus に解決するため既定で 4.8 を使用。設定画面のモデル表記を `claude-opus-4-8` に更新し、コスト推定表に `claude-opus-4-8` を追加（旧 ID も履歴セッションのコスト再構築用に保持）。

### Tests
- jimmy: 452 tests pass（`PUT /api/config` の deep-merge が interactive フラグを設定しつつ connector secret/他フィールドを保持することの回帰テストを追加）。

## [2026.6.4] - 2026-06-03

### Features
- **インタラクティブモードのセットアップ・プロンプト**: `ryoko setup` / `ryoko update` で、Claude をインタラクティブ PTY（Max 定額課金）で動かすか対話で選べるように。TTY のときのみ・未設定のときのみ尋ね、CI/cron ではスキップ。`update` では再起動前に尋ねるので選択が即反映されます。
- **`ryoko config interactive [on|off]`**: ダッシュボード不要で `engines.claude.interactive` を確認・変更できる CLI。設定の書き込みは行ベースで config.yaml のコメント・整形を保持し、`engines.claude` ブロックにスコープ限定（他セクションの同名キーを誤爆しない）。

### Tests
- jimmy: 450 tests pass（`interactive-config` の行ベース編集・ブロックスコープ・各値形式の回帰テストを追加）。

## [2026.6.3] - 2026-06-03

本家 jinn の engine sprint からの移植 + 独自堅牢化。

### Features
- **Interactive Claude PTY エンジン（オプトイン）**: `config.engines.claude.interactive: true` で、Claude の作業ターンを headless `claude -p`（API 従量課金）ではなく**インタラクティブ PTY**（`cc_entrypoint=cli`）で実行。Max サブスクリプション課金になり API 課金を回避します。ターン解決は Claude Code の Stop フックを per-session `--settings` で登録し、`hook-relay.mjs` が loopback の `POST /api/internal/hook`（secret 認証）へ転送 → `HookRegistry` → `TurnResolver` で解決。既定は従来の `claude -p`。`sshHost` 従業員は PTY 不可のため headless `-p` フォールバックへ委譲。新規依存 `node-pty`。
- **ライブ xterm CLI ビュー**: `/ws/pty/:sessionId` WebSocket でセッションの PTY をブラウザの xterm に直結（`@xterm/xterm`）。`/api/status` の `engines.claude.interactive` で UI が live xterm / poll transcript を切替。
- **コンテキストメーター**: codex / claude 両エンジンで直近ターンの入力コンテキスト量（input + cache）を計測・永続化（`sessions.last_context_tokens`）し、Web にバッジ表示。

### Fixes
- **Slack リアクション承認（古いメッセージ）**: boot-replay ガードをリアクションの `event_ts` で判定するよう変更し、数時間待った承認カードへの新規リアクションが落ちる問題を解消。`:eyes:` 即時 ack を追加（本家 v0.17.1 相当）。

### Hardening / Security
- Interactive エンジンに**ターンタイムアウト**（既定 15 分, `interactiveTurnTimeoutMs`）を追加し、ハングした PTY がセッションをゾンビ化しないように。
- 起動時に `seedTrust(~/.claude.json, JINN_HOME)` で PTY 起動 claude の trust ダイアログを回避。
- `/ws` / `/ws/pty` の upgrade に host ガード、`/ws/pty` に Origin allowlist（stdin 注入対策）、sessionId の `decodeURIComponent` を try/catch 化。

### Tests
- jimmy: 442 tests pass（PTY ライフサイクル / hook registry+endpoint / SSE proxy / claude-interactive / SSH フォールバック / claude-settings 等を移植・追加）。

## [2026.5.29] - 2026-05-29

### Features
- **`ryoko update --restart`**: CLI 更新（＋マイグレーション）の後にゲートウェイを自動再起動するオプションを追加。再起動先は systemd `--user` ユニット → systemd system ユニット（既定名 `openryoko`）→ フォークデーモン（PIDファイル/ポート）の順に自動検出します。system ユニットへ直接 `systemctl restart` する権限が無い場合は `sudo -n` を試行し、それも不可なら手動コマンドを案内します。何も起動していなければ何もしません（`none`）。既定の `ryoko update` は従来どおり再起動しません（安全側のオプトイン）。
- **`ryoko update --service <name>` / `RYOKO_SERVICE`**: 再起動する systemd ユニット名を上書き可能に（既定 `openryoko`）。Linux 以外では systemd 検出をスキップしデーモン経路のみ。

### Tests
- jimmy: 32 files / 377 tests pass。
- `restartGateway()` の検出ロジック（systemd user/system、sudo フォールバック、権限拒否、サービス名上書き、デーモン再fork、none、非Linux）の回帰テスト（`restart.test.ts`）を追加。

## [2026.5.28] - 2026-05-28

### Features
- **Slack Assistant「新しいチャット」= 新セッション**: Assistant（Agents & AI Apps）の各チャットが持つ `thread_ts` ごとに独立した DM セッションを張るようにしました。「新しいチャット」を押すと、その時点の `engines.default` で新規セッションが始まります（従来は DM 全体が1セッションに合流し、最初に作られたエンジンに固定され続けていました）。`thread_ts` の無い素の DM は従来どおり1ユーザー1セッションを継続。`buildReplyContext` も threaded DM では当該スレッドに返信するよう変更。
- **Slack App manifest: Assistant 機能をデフォルト ON**: Settings のコピペ用 manifest に `features.assistant_view` ＋ `assistant:write` scope ＋ `assistant_thread_started` / `assistant_thread_context_changed` events を既定で含め、新規アプリでも「新しいチャット」が即使える状態にしました。
- **manifest の bot 名テンプレート化**: manifest の `display_information.name` / `bot_user.display_name` を設定済みの bot 名（`portalName`）から生成。未設定時のみ "Ryoko"。

### Fixes
- **Slack slash commands in threads**: スレッド内（および thread context 付きメッセージ）で `/new` `/status` `/model` `/doctor` `/cron` が無視されていた問題を修正。connector が付与する「[Thread context — parent message: …]」プリアンブルでコマンドが先頭から押し出され、エンジンに素通りしていたのが原因。生のユーザーテキストでコマンド判定し、コマンド時はプリアンブルを付けないようにしました（`SLASH_COMMANDS` / `startsWithSlashCommand()` を共有ヘルパー化）。特に `/new` が効かずスレッドが元エンジンを再開し続ける問題を解消。
- **Codex interim narration leak**: Codex エンジンの `text` イベントは（streaming delta ではなく）`item.completed` の完成済み agent_message を運ぶため、全て連結すると gpt-5.5 の中間進捗（例「まず boot ファイルを確認します」）が本回答の前に混ざっていました。最新の agent_message のみを結果として採用するよう修正（途中経過は従来どおり onStream で表示）。Gemini の delta 蓄積は正しいので不変更。
- **Agents View Canvas self-disable**: canvas 作成失敗（`canvas_tab_creation_failed` 等）時に 30s ごとへ無限リトライしてログと Slack API を叩き続ける問題を修正。連続 tick 失敗を数え、10回連続（既定間隔で約5分）で ERROR ログを出してループ停止。成功でカウンタはリセットするので一時的障害では止まりません。

### Improvements
- **Slack 受信ログ**: inbound メッセージのログに `channel_type` / `thread_ts` / `subtype` を出力し、スレッド / Assistant 周りの切り分けをしやすくしました。

### Tests
- jimmy: 31 files / 369 tests pass。web: typecheck pass。
- per-thread DM keying と reply context の回帰テスト（`threads.test.ts`）を追加。
- slash command の thread-context 内検出（`slash-commands.test.ts`）、Codex interim narration（`codex.test.ts`）、Agents Canvas 連続失敗時の self-disable（`agents-canvas.test.ts`）の回帰テストを追加。

## [2026.5.22] - 2026-05-22

### Features
- **Slack air-reading triage on Codex**: 空気読みトリアージの one-shot 判定を Claude だけでなく Codex でも実行できるようにしました。デフォルトは軽量な `codex` + `gpt-5-nano` です。
- **Goal extraction controls**: Slack の自然言語 goal 判定を `connectors.slack.goalExtraction.enabled` でオン/オフ可能にしました。遅延が目立つためデフォルトはオフです。
- **Web UI settings**: Settings 画面から Slack triage / goal extraction の engine、model、timeout、bin override を設定できるようにしました。

### Fixes
- **Slack threaded replies**: connector `/send` に `thread` がある場合は threaded reply として送信し、顧客向け返信がチャンネル直下に裸で投稿される事故を防ぎます。
- **Current conversation duplicate guard**: gateway MCP の `send_message` が現在会話へ投稿しようとした場合は拒否し、最終回答で返すよう促します。実返信と内部ナレーションの二重投稿を防ぎます。
- **Codex goal guard**: `/goal` は Claude 専用として扱い、Codex セッションでは実行しないようにしました。
- **Agents View Canvas**: `canvases.edit` 失敗時に無条件で Canvas ID を破棄していた挙動を修正。Slack API の恒久的な edit エラーで次回 tick が新規 Canvas 作成に戻り、Canvas が増殖する問題を防ぎます。Canvas が削除済み/見つからない場合だけ再作成します。
- **Migration auto mode**: `ryoko migrate --auto` が既存ファイルを skip した場合、version stamp と cleanup を行わないようにしました。未マージの重要テンプレートがあるのに最新版扱いになる問題を防ぎます。
- **Migration CLI copy**: `ryoko migrate` の表示と migrate skill の説明に残っていた `.jinn` / `jinn migrate` 表記を `.ryoko` / `ryoko migrate` に更新。
- **Version migration ordering**: `2026.5.7` のような OpenRyoko CalVer migration を、歴史的な `0.x.y` migration と同じ3セグメント数値版として正しく比較・ソートします。
- **Cost tests isolation**: gateway cost tests が実ユーザーの runtime DB を触らないよう、テスト用 DB に隔離しました。

### Improvements
- **2026.5.7 migration payload**: persona / memory layer の新規・更新テンプレートを migration `files/` 配下にも同梱し、AI migration がコピーまたはマージしやすい形にしました。

### Tests
- jimmy: 28 files / 347 tests pass。
- web: typecheck pass。
- Agents View Canvas の edit 失敗時に Canvas を重複作成しない回帰テストを追加。
- CalVer migration ordering の unit test を追加。
- Slack triage / goal extraction の Codex one-shot 実行と、goal extraction デフォルトオフの回帰テストを追加。

## [2026.4.30] - 2026-04-30

### 🐛 Fixes
- **Slack triage**: conversations now skip triage as soon as the bot has engaged AND only one human is speaking — scoped per-thread for threaded replies, and per-`(channel, user)` for non-threaded follow-ups. The decision is permanent until a third human joins (no TTL). Closes the silent-drop class of bugs where a bot+1 private channel was classified as `channel` and slow Haiku triage caused real user messages to be ignored, and also fixes the same problem for users who don't reply in threads. Replaces the old 10-minute `ActiveThreadTracker` window and the channel-membership-based DM-equivalent detector.
- **Slack triage**: bumped `DEFAULT_TIMEOUT_MS` from 8s to 30s. Real-world Haiku one-shot calls land at 5–9s in normal conditions and spike higher on slow API days; the 8s default was producing routine timeouts. Operators can still override via `connectors.slack.triage.timeoutMs` in `config.yaml`.

### 🗑 Deprecated
- `connectors.slack.triage.activeThreadTtlMs` — no longer used. Engagement is tracked permanently per-conversation now. The field is still accepted for backwards compatibility but has no effect.

## [2026.4.28] - 2026-04-28

### ✨ Features
- **`ryoko update`** — `npm install -g openryoko@latest` と `ryoko migrate --auto` を1コマンドで実行できるようにしました。`--no-migrate` でCLI更新だけも可能です。

## [2026.4.27] - 2026-04-27

### 🐛 Fixes
- **Slack typing indicator** — Slack の `assistant.threads.setStatus` を90秒ごとに更新し、長時間のエンジン実行中も「入力中...」表示が消えにくいように変更。
- **Slack status diagnostics** — typing status API の失敗を `warn` ログに出し、`missing_scope` / `no_permission` / `invalid_thread_ts` などの原因を確認しやすくしました。

## [2026.4.26] - 2026-04-26

### 🚀 リモートサーバー (Linux/systemd) 運用での詰まりポイントを一掃

VPS等で常駐させようとした初期ユーザーが踏んだ4つの落とし穴を全部潰しました。

#### 🐛 Fixes
- **`spawn claude ENOENT` (systemd配下)** — エンジン (Claude/Codex/Gemini) およびSlackトリアージのCLI起動を、起動時に純JSのPATH探索 (`shared/resolveBin.ts`) で絶対パス化するように変更。systemdの最小PATHでも動作。解決失敗時はインストールコマンド付きの親切なエラーを返す。
- **rootユーザーでClaude CLI拒否** — `shared/childEnv.ts` でuid==0検出時に `IS_SANDBOX=1` を自動付与しバイパス。同時に「root実行は非推奨、専用ユーザーを推奨」の警告ログを一度だけ出力。
- **WebUI Settingsで Slack トークン保存しても繋がらない** — `PUT /api/config` および `chokidar` watcher が、`connectors` または `portal.portalName/operatorName` の差分を検知すると `reloadAllConnectors()` を呼んでトップレベル＋インスタンスSlack/Discord/Telegram/WhatsAppコネクタを再接続。デーモン再起動不要。partial失敗 (例: 不正トークン) はUIにエラー表示。
- **クラッシュ後の自動復旧なし** — `scripts/systemd/openryoko.service` テンプレと `scripts/systemd/install.sh` を追加。`Restart=on-failure` + `RestartSec=5` で自動復旧。インストーラはユーザーの実シェル (bash/zsh/fish) でPATHを自動検出してunit fileに焼き込む。

#### 🏗️ Infrastructure
- `engines.node: ">=22"` を root / `packages/jimmy` / `packages/web` の package.json に明示。
- READMEに「🖥️ Linux サーバーで常駐させる (systemd)」セクションを追加。
- `SessionManager.setConfig()` / `setConnectorNames()` を追加 — config再読み込み時にセッションが boot 時の値を引きずる問題を解消。
- 連結器reloadを single-flight 化 (`reloadInFlight` mutex + pending coalescing) — 並行reload時の二重起動を防止。
- 連結器の停止 (`stop()`) が失敗した場合、参照を破棄せず手動再起動を案内 — 二重ライブクライアントによる重複応答を防止。
- API経由のconfig書き込み時に watcher の重複reloadを抑制 (`suppressNextConnectorReload`)、partial失敗時は抑制を解除して chokidar の retry チャンスを残す。

#### 🔒 Security
- `resolveBin` で `command -v ${bin}` のシェル展開を撤廃し、純JSの `process.env.PATH` 走査に置換。`engines.*.bin` を `PUT /api/config` 経由で書き換えられるため、シェルメタ文字を含む値で任意コマンド実行できてしまう脆弱性を修正。
- 同時に bin 名に `/`, `\`, NULL バイトを含む値を拒否 (path traversal 防御)。

#### ✅ Tests
- 新規: `shared/__tests__/resolveBin.test.ts` (絶対パス・PATH解決・コマンドインジェクション耐性)、`shared/__tests__/childEnv.test.ts` (root検出と IS_SANDBOX 注入)、`sessions/__tests__/manager-connector-names.test.ts` (setConnectorNames)
- jimmy: 23 files / **275 tests**、web: 7 files / 61 tests、すべて pass。

## [0.9.4-ryoko.2] - 2026-04-22

### 🐛 Fixes
- **Slack triage**: shared-channel barge-in fix — triage errors in ambient messages now fail silent (not reply) when `botUserId` is known, and explicit `<@other-user>` mentions are early-skipped regardless of thread activity. Breaks the cascade where one fail-open reply would mark a thread "active" and cause follow-ups to bypass triage for 10 minutes. ([#slack-triage](https://github.com/rsensui2/OpenRyoko/commit/61a010c))
- **Web chat input (IME)**: Enter during Japanese/Chinese/Korean IME composition no longer submits the message. Fixes split-message bug where confirming an IME conversion sent partial text. (#1, thanks @htpboost)

## [0.7.0] - 2026-03-19

### ✨ Features — Project Phoenix
- **Chat tabs** — Cmd+W close, Cmd+Shift+[/] switch, draft persistence, status indicators
- **Command palette** — cmdk-powered Cmd+K with actions, recents, sessions, skills search
- **Breadcrumb navigation** — context-aware breadcrumbs on all pages
- **ChatPane extraction** — reusable chat component decoupled from page
- **Enhanced sidebar** — expandable employee groups, pin/unpin, context menu, hover actions
- **React Query data layer** — query key factory, hooks for all resources, WS→cache invalidation bridge

### 🔧 Improvements
- **Tailwind migration** — 640→120 inline styles (81% reduction), shadcn token system
- **Header consolidation** — single 40px tab bar replaces 3 stacked headers on chat
- **Mobile UX** — more menu in top header, clean tab bar, responsive sidebar
- **Session state sync** — tabs and selected session stay in sync
- **Instant tab switching** — no scroll flash, useLayoutEffect for immediate scroll

### 🏗️ Infrastructure
- Goals CRUD API + SQLite table (backend, for future use)
- Cost aggregation API + budget enforcement system
- Mock engine for E2E tests
- Vitest setup (api + web), Playwright config, GitHub Actions CI workflow

### 🧹 Cleanup
- Removed: split view, goals/costs pages (no backend yet), 14 unused shadcn components
- Fixed: dual-fetch anti-pattern in sidebar, session delete via mutations
- Net: 81 files changed, +5,608 / -8,723 lines

## [0.3.0] - 2026-03-10

### 🔧 Improvements
- Codex engine now runs with `--dangerously-bypass-approvals-and-sandbox` — prevents Jimmy-managed Codex sessions from being constrained by CLI sandbox/approval defaults

## [0.2.0] - 2026-03-10

### ✨ Features
- Connector abstraction layer — connectors declare capabilities (threading, reactions, edits, attachments) and health status
- `replyMessage()` vs `sendMessage()` split — proper thread-aware message routing
- CronConnector — cron jobs are now message sources routed through SessionManager (unified flow)
- Slack config options — `shareSessionInChannel`, `allowFrom` whitelist, `ignoreOldMessagesOnBoot`
- Transport state tracking — new `transportState` field + queue depth visibility
- In-chat slash commands — `/cron list|run|enable|disable`, `/model <name>`, `/doctor`
- Runtime cron control — trigger/enable/disable jobs without restart
- Web UI: Slack settings toggles for new config options
- Web UI: Transport visibility — connector name, queue depth, transport state badges

### 🔧 Improvements
- Unified message routing — all sources flow through `SessionManager.route()` with uniform `IncomingMessage`
- Cron runner simplified — ~35% code reduction by delegating to SessionManager
- Capability-aware decorations — reactions/edits conditional on connector capabilities
- Config token masking — Slack tokens masked in `GET /api/config`
- Session queue monitoring — `getPendingCount()` and `getTransportState()`

### 🏗️ Infrastructure
- Build pipeline — web UI bundled into gateway dist
- Test suite — threads, queue, and registry tests using Node.js native test runner
- DB migration — auto-adds connector/transport columns, backfills from legacy fields

### 💥 Breaking Changes
- `Connector` interface expanded with new required methods: `replyMessage()`, `getCapabilities()`, `getHealth()`, `reconstructTarget()`
- `IncomingMessage` and `Session` types have new required fields
- `GET /api/connectors` response shape changed from `string[]` to objects with capabilities
- `startScheduler()` now takes `SessionManager` instead of engine map
- `sendMessage()` no longer posts to threads — use `replyMessage()`

## [0.1.1] - 2026-03-09

### 🐛 Bug Fixes
- Remove `@jinn/web` workspace dependency from published package — was causing `unsupported URL type "workspace:"` error on `npm i -g jinn-cli` (web UI is embedded as static files during build, not a runtime dependency)

### 🔧 Improvements
- Claude engine now runs with `--dangerously-skip-permissions` — prevents sessions from hanging on tool approval prompts in headless mode

## [0.1.0] - 2026-03-09

First release of the Jinn AI gateway platform.

### ✨ Core Platform
- Gateway server with HTTP REST API + WebSocket real-time events
- Session manager with context builder (32K char budget, progressive trimming)
- SQLite session registry with WAL mode
- Per-session serial execution queue
- File watchers for hot-reload (config, cron, org, skills)
- Daemon lifecycle management (start/stop/status as background process)
- Multi-instance support with dynamic home directory resolution

### ✨ Engines
- Claude Code CLI engine wrapper (spawn, JSON streaming, session resume)
- Codex SDK engine wrapper (in-process, streaming)
- Model/effort level passthrough and configuration

### ✨ CLI
- `jinn setup` — bootstrap ~/.jinn/ from templates
- `jinn start` / `stop` / `status` — daemon management
- `jinn create` / `list` / `remove` — instance management
- `jinn nuke` — permanent instance deletion with safety prompts
- `jinn migrate` — AI-assisted template migrations
- `jinn skills` — skill discovery + skills.sh integration
- `--port` flag for custom port binding

### ✨ Connectors
- Slack connector (Socket Mode via @slack/bolt)
- Thread/DM/channel source-ref mapping
- Reaction workflow (👀 → ✅/❌)
- Message splitting for long responses
- Attachment download support

### ✨ Organization System
- Employee personas (YAML) with departments, ranks, engine assignment
- Org scanner with @mention routing
- Department boards for inter-agent task tracking
- Rich employee identity + generic connector context
- Dynamic COO naming via onboarding

### ✨ Skills System
- Markdown-based skill playbooks (SKILL.md with YAML frontmatter)
- 10 built-in skills: management, cron-manager, skill-creator, self-heal, onboarding, migrate, sync, status, new, find-and-install
- Skill symlink syncing to .claude/skills/ and .agents/skills/
- skills.sh marketplace integration
- Skills directory watcher with WebSocket change events

### ✨ Cron System
- node-cron scheduler with hot-reloadable jobs.json
- Run logging to JSONL files
- Delegation pattern (cron → COO → employee → review → deliver)
- Optional delivery to connectors

### ✨ Web UI
- Full Next.js 15 static dashboard
- Chat interface with voice recording, file attachments, rich markdown
- Session browser with detail view
- Org map (React Flow) with grid/feed views + employee detail panels
- Kanban board with drag-drop, tickets, employee assignment
- Cron visualizations — weekly schedule heatmap, pipeline grid
- Cost dashboard with charts, anomaly detection, WoW comparison
- Activity console with log browser + floating live stream widget
- Global search (Cmd+K)
- Settings page + onboarding wizard
- 5-theme CSS system with accent color support
- shadcn/ui components

### ✨ Session Context
- Rich context injection (identity, CLAUDE.md, config, org, skills, cron, connectors, API reference)
- Local environment awareness
- Lazy onboarding (stub session)

### 🏗️ Infrastructure
- pnpm + Turborepo monorepo
- TypeScript throughout
- Web UI bundled into CLI package
- CI workflow (GitHub Actions)
- README, CONTRIBUTING guide, LICENSE
