import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { JinnConfig, Connector, Employee } from "../shared/types.js";
import { loadConfig } from "../shared/config.js";
import { configureLogger, logger } from "../shared/logger.js";
import { initDb, recoverStaleSessions, recoverStaleQueueItems, getInterruptedSessions, listSessions, updateSession } from "../sessions/registry.js";
import { SessionManager, type RouteOptions } from "../sessions/manager.js";
import { ClaudeEngine } from "../engines/claude.js";
import { CodexEngine } from "../engines/codex.js";
import { GeminiEngine } from "../engines/gemini.js";
import { handleApiRequest, resumePendingWebQueueItems, type ApiContext } from "./api.js";
import { ensureFilesDir } from "./files.js";
import { initStt } from "../stt/stt.js";
import { startWatchers, stopWatchers, syncSkillSymlinks } from "./watcher.js";
import { SlackConnector } from "../connectors/slack/index.js";
import { DiscordConnector, type DiscordConnectorConfig } from "../connectors/discord/index.js";
import { RemoteDiscordConnector } from "../connectors/discord/remote.js";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { TelegramConnector } from "../connectors/telegram/index.js";
import { loadJobs } from "../cron/jobs.js";
import { startScheduler, reloadScheduler, stopScheduler } from "../cron/scheduler.js";
import { scanOrg } from "./org.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webDir: string,
): boolean {
  if (!fs.existsSync(webDir)) return false;

  // Strip query string before resolving file path
  const urlPath = (req.url || "/").split("?")[0];
  let filePath = path.join(webDir, urlPath);
  if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");

  // Prevent directory traversal
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(webDir))) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    // Next.js static export produces /chat.html, /sessions.html, etc.
    // Try appending .html before falling back to index.html
    const htmlPath = resolved.endsWith("/")
      ? path.join(resolved, "index.html")
      : resolved + ".html";
    if (fs.existsSync(htmlPath) && !fs.statSync(htmlPath).isDirectory()) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(htmlPath).pipe(res);
      return true;
    }

    // SPA fallback: serve index.html for non-API, non-WS routes
    const indexPath = path.join(webDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }
    return false;
  }

  const ext = path.extname(resolved);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

export type GatewayCleanup = () => Promise<void>;

export async function startGateway(
  config: JinnConfig,
): Promise<GatewayCleanup> {
  const bootId = randomUUID().slice(0, 8);

  // Configure logging
  configureLogger({
    level: config.logging.level,
    stdout: config.logging.stdout,
    file: config.logging.file,
  });

  const gatewayName = config.portal?.portalName || "Ryoko";
  logger.info(`Starting ${gatewayName} gateway (boot ${bootId}, pid ${process.pid})...`);

  // Initialize database and recover any sessions stuck from a previous run
  initDb();
  ensureFilesDir();
  const recovered = recoverStaleSessions();
  if (recovered > 0) {
    logger.info(`Recovered ${recovered} stale session(s) — marked as "interrupted" for resume`);
  }

  // Log resumable sessions so operators know what can be picked up
  const resumable = getInterruptedSessions();
  if (resumable.length > 0) {
    logger.info(`${resumable.length} interrupted session(s) available for resume:`);
    for (const s of resumable) {
      logger.info(`  - ${s.id} (engine: ${s.engine}, employee: ${s.employee || "none"}, engineSessionId: ${s.engineSessionId})`);
    }
  }
  const recoveredQueue = recoverStaleQueueItems();
  if (recoveredQueue > 0) {
    logger.info(`Recovered ${recoveredQueue} in-flight queue item(s) from previous run — reset to pending`);
  }

  // Set up engines
  const claudeEngine = new ClaudeEngine();
  const codexEngine = new CodexEngine();
  const geminiEngine = new GeminiEngine();
  const engines = new Map<string, InstanceType<typeof ClaudeEngine> | InstanceType<typeof CodexEngine> | InstanceType<typeof GeminiEngine>>();
  engines.set("claude", claudeEngine);
  engines.set("codex", codexEngine);
  engines.set("gemini", geminiEngine);

  // Derive connector names from config
  const connectorNames: string[] = [];
  if (config.connectors?.slack?.appToken && config.connectors?.slack?.botToken) {
    connectorNames.push("slack");
  }
  if (config.connectors?.discord?.botToken || config.connectors?.discord?.proxyVia) {
    connectorNames.push("discord");
  }
  if (config.connectors?.telegram?.botToken) {
    connectorNames.push("telegram");
  }
  if (config.connectors?.whatsapp) {
    connectorNames.push("whatsapp");
  }

  // Session manager
  const sessionManager = new SessionManager(config, engines, connectorNames);

  // Build employee registry
  let employeeRegistry = scanOrg();
  logger.info(`Loaded ${employeeRegistry.size} employee(s) from org directory`);

  // Start connectors
  const connectors: Connector[] = [];
  const connectorMap = new Map<string, Connector>();
  /** IDs of connectors created from config.connectors.instances[] (vs legacy top-level connectors) */
  const instanceConnectorIds = new Set<string>();

  // ---- Top-level connector start/stop helpers (closure over employeeRegistry, connectors, etc.) ----
  // These are defined here so they can be reused by both initial startup AND
  // reloadAllConnectors() when config.yaml changes (e.g. user saves new Slack
  // tokens via the WebUI).

  async function stopTopLevelConnectors(): Promise<{ stopped: string[]; errors: string[] }> {
    const stopped: string[] = [];
    const errors: string[] = [];
    for (const [id, connector] of [...connectorMap.entries()]) {
      // Instance-based connectors are handled by reloadConnectorInstances()
      if (instanceConnectorIds.has(id)) continue;
      try {
        await connector.stop();
        // stop() succeeded — safe to drop reference and let reload recreate.
        connectorMap.delete(id);
        const idx = connectors.indexOf(connector);
        if (idx >= 0) connectors.splice(idx, 1);
        stopped.push(id);
        logger.info(`Stopped top-level connector "${id}" for reload`);
      } catch (err) {
        // stop() FAILED. Don't drop the reference: the underlying client
        // (Slack websocket, Discord gateway, etc.) may still be live. If we
        // recreated it now, we'd have two live clients processing the same
        // events and sending duplicate replies. Better to surface a loud
        // error and require a daemon restart for recovery.
        const message = `stop() failed for top-level connector "${id}" — leaving in place to avoid duplicate replies. A full daemon restart may be required. Error: ${err instanceof Error ? err.message : err}`;
        logger.error(message);
        errors.push(message);
      }
    }
    return { stopped, errors };
  }

  async function startTopLevelConnectorsFromConfig(
    cfg: JinnConfig,
  ): Promise<{ started: string[]; errors: string[] }> {
    const started: string[] = [];
    const errors: string[] = [];

    if (
      cfg.connectors?.slack?.appToken &&
      cfg.connectors?.slack?.botToken &&
      !connectorMap.has("slack")
    ) {
      try {
        const slack = new SlackConnector(
          {
            appToken: cfg.connectors.slack.appToken,
            botToken: cfg.connectors.slack.botToken,
            allowFrom: cfg.connectors.slack.allowFrom,
            ignoreOldMessagesOnBoot: cfg.connectors.slack.ignoreOldMessagesOnBoot,
            triage: cfg.connectors.slack.triage,
          },
          {
            portalName: cfg.portal?.portalName,
            operatorName: cfg.portal?.operatorName,
          },
        );
        slack.onMessage((msg) => {
          const routeOpts: RouteOptions = {};
          if (cfg.connectors.slack?.employee) {
            const emp = employeeRegistry.get(cfg.connectors.slack.employee);
            if (emp) routeOpts.employee = emp;
          }
          sessionManager.route(msg, slack, routeOpts).catch((err) => {
            logger.error(`Slack route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await slack.start();
        connectors.push(slack);
        connectorMap.set("slack", slack);
        started.push("slack");
      } catch (err) {
        const msg = `Failed to start Slack connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    if (cfg.connectors?.discord?.proxyVia && !connectorMap.has("discord")) {
      try {
        const discord = new RemoteDiscordConnector({
          proxyVia: cfg.connectors.discord.proxyVia,
          channelId: cfg.connectors.discord.channelId,
        });
        discord.onMessage((msg) => {
          const routeOpts: RouteOptions = {};
          if (cfg.connectors.discord?.employee) {
            const emp = employeeRegistry.get(cfg.connectors.discord.employee);
            if (emp) routeOpts.employee = emp;
          }
          sessionManager.route(msg, discord, routeOpts).catch((err) => {
            logger.error(`Discord route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await discord.start();
        connectors.push(discord);
        connectorMap.set("discord", discord);
        started.push("discord");
        logger.info("Discord remote connector started");
      } catch (err) {
        const msg = `Failed to start remote Discord connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    } else if (cfg.connectors?.discord?.botToken && !connectorMap.has("discord")) {
      try {
        const discord = new DiscordConnector(cfg.connectors.discord as DiscordConnectorConfig);
        discord.onMessage((msg) => {
          const routeOpts: RouteOptions = {};
          if (cfg.connectors.discord?.employee) {
            const emp = employeeRegistry.get(cfg.connectors.discord.employee);
            if (emp) routeOpts.employee = emp;
          }
          sessionManager.route(msg, discord, routeOpts).catch((err) => {
            logger.error(`Discord route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await discord.start();
        connectors.push(discord);
        connectorMap.set("discord", discord);
        started.push("discord");
        logger.info("Discord connector started");
      } catch (err) {
        const msg = `Failed to start Discord connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    if (cfg.connectors?.telegram?.botToken && !connectorMap.has("telegram")) {
      try {
        const telegram = new TelegramConnector({
          botToken: cfg.connectors.telegram.botToken,
          allowFrom: cfg.connectors.telegram.allowFrom,
          ignoreOldMessagesOnBoot: cfg.connectors.telegram.ignoreOldMessagesOnBoot,
        });
        telegram.onMessage((msg) => {
          const routeOpts: RouteOptions = {};
          if (cfg.connectors.telegram?.employee) {
            const emp = employeeRegistry.get(cfg.connectors.telegram.employee);
            if (emp) routeOpts.employee = emp;
          }
          sessionManager.route(msg, telegram, routeOpts).catch((err) => {
            logger.error(`Telegram route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await telegram.start();
        connectors.push(telegram);
        connectorMap.set("telegram", telegram);
        started.push("telegram");
      } catch (err) {
        const msg = `Failed to start Telegram connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    if (cfg.connectors?.whatsapp && !connectorMap.has("whatsapp")) {
      try {
        const whatsapp = new WhatsAppConnector(cfg.connectors.whatsapp ?? {});
        whatsapp.onMessage((msg) => {
          const routeOpts: RouteOptions = {};
          if (cfg.connectors.whatsapp?.employee) {
            const emp = employeeRegistry.get(cfg.connectors.whatsapp.employee);
            if (emp) routeOpts.employee = emp;
          }
          sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
            logger.error(`WhatsApp route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await whatsapp.start();
        connectors.push(whatsapp);
        connectorMap.set("whatsapp", whatsapp);
        started.push("whatsapp");
        logger.info("WhatsApp connector started (scan QR code if first run)");
      } catch (err) {
        const msg = `Failed to start WhatsApp connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    return { started, errors };
  }

  // Initial top-level connector startup
  await startTopLevelConnectorsFromConfig(config);

  // Process named connector instances (allows multiple connectors of the same type)
  if (config.connectors?.instances) {
    for (const instance of config.connectors.instances) {
      const { id, type, employee, ...typeConfig } = instance;
      if (!id || !type) {
        logger.warn(`Skipping connector instance without id or type`);
        continue;
      }
      if (connectorMap.has(id)) {
        logger.warn(`Duplicate connector instance id "${id}", skipping`);
        continue;
      }

      try {
        let connector: Connector;
        switch (type) {
          case "discord": {
            const discordConfig = { ...typeConfig, id } as DiscordConnectorConfig;
            const discord = new DiscordConnector(discordConfig);
            discord.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, discord, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await discord.start();
            connector = discord;
            break;
          }
          case "slack": {
            const slackConfig = { ...typeConfig, id } as any;
            const slack = new SlackConnector(slackConfig, {
              portalName: config.portal?.portalName,
              operatorName: config.portal?.operatorName,
            });
            slack.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, slack, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await slack.start();
            connector = slack;
            break;
          }
          case "whatsapp": {
            const whatsapp = new WhatsAppConnector({ ...typeConfig } as any);
            whatsapp.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await whatsapp.start();
            connector = whatsapp;
            break;
          }
          case "telegram": {
            const telegramConfig = { ...typeConfig, id } as any;
            const tg = new TelegramConnector(telegramConfig);
            tg.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, tg, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await tg.start();
            connector = tg;
            break;
          }
          default:
            logger.warn(`Unknown connector type "${type}" for instance "${id}"`);
            continue;
        }
        connectors.push(connector);
        connectorMap.set(id, connector);
        instanceConnectorIds.add(id);
        logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
      } catch (err) {
        logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  sessionManager.setConnectorProvider(() => connectorMap);

  // Reload connector instances from config (stop old instances, start new ones)
  /**
   * Stop only the instance-based connectors. Split out from the legacy
   * combined reload so reloadAllConnectors() can interleave: stop top-level
   * + stop instances → start top-level → start instances. That order
   * preserves boot-time precedence (top-level wins for duplicate ids).
   */
  async function stopInstanceConnectors(): Promise<{ stopped: string[]; errors: string[] }> {
    const stopped: string[] = [];
    const errors: string[] = [];
    for (const [id, connector] of [...connectorMap.entries()]) {
      if (!instanceConnectorIds.has(id)) continue;
      try {
        await connector.stop();
        // stop() succeeded — safe to drop reference and let restart create afresh.
        connectorMap.delete(id);
        instanceConnectorIds.delete(id);
        const idx = connectors.indexOf(connector);
        if (idx >= 0) connectors.splice(idx, 1);
        stopped.push(id);
        logger.info(`Stopped connector instance "${id}" for reload`);
      } catch (err) {
        // stop() FAILED. Same reasoning as stopTopLevelConnectors: leave
        // the reference in place rather than risk duplicate live clients.
        const message = `stop() failed for instance "${id}" — leaving in place to avoid duplicate replies. A full daemon restart may be required. Error: ${err instanceof Error ? err.message : err}`;
        logger.error(message);
        errors.push(message);
      }
    }
    return { stopped, errors };
  }

  async function startConfiguredInstances(
    freshConfig: JinnConfig,
  ): Promise<{ started: string[]; errors: string[] }> {
    const started: string[] = [];
    const errors: string[] = [];
    if (freshConfig.connectors?.instances) {
      for (const instance of freshConfig.connectors.instances) {
        const { id, type, employee, ...typeConfig } = instance;
        if (!id || !type) continue;
        if (connectorMap.has(id)) continue;

        try {
          let connector: Connector;
          switch (type) {
            case "discord": {
              const discordConfig = { ...typeConfig, id } as DiscordConnectorConfig;
              const discord = new DiscordConnector(discordConfig);
              discord.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, discord, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await discord.start();
              connector = discord;
              break;
            }
            case "slack": {
              const slackConfig = { ...typeConfig, id } as any;
              // Use freshConfig.portal (not the closure-captured boot-time
              // `config`) so renamed portals show up after a hot-reload.
              const slack = new SlackConnector(slackConfig, {
                portalName: freshConfig.portal?.portalName,
                operatorName: freshConfig.portal?.operatorName,
              });
              slack.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, slack, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await slack.start();
              connector = slack;
              break;
            }
            case "whatsapp": {
              const whatsapp = new WhatsAppConnector({ ...typeConfig } as any);
              whatsapp.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await whatsapp.start();
              connector = whatsapp;
              break;
            }
            case "telegram": {
              const telegramConfig = { ...typeConfig, id } as any;
              const tg = new TelegramConnector(telegramConfig);
              tg.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, tg, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await tg.start();
              connector = tg;
              break;
            }
            default:
              errors.push(`Unknown connector type "${type}" for instance "${id}"`);
              continue;
          }
          connectors.push(connector);
          connectorMap.set(id, connector);
          instanceConnectorIds.add(id);
          started.push(id);
          logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
        } catch (err) {
          errors.push(`Failed to start "${id}": ${err instanceof Error ? err.message : err}`);
          logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    return { started, errors };
  }

  /**
   * Backwards-compatible wrapper: stop+start instances in one call. Used by
   * the `POST /api/connectors/reload` endpoint and exposed via ApiContext
   * for any external consumer that still calls reloadConnectorInstances().
   */
  async function reloadConnectorInstances(
    preloadedConfig?: JinnConfig,
  ): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    const fresh = preloadedConfig ?? loadConfig();
    const stopRes = await stopInstanceConnectors();
    const startRes = await startConfiguredInstances(fresh);
    return {
      started: startRes.started,
      stopped: stopRes.stopped,
      errors: [...stopRes.errors, ...startRes.errors],
    };
  }

  /**
   * Stop and re-initialize ALL connectors (top-level + instance-based) from
   * the on-disk config. Called automatically when ~/.ryoko/config.yaml
   * changes via the chokidar watcher, and via POST /api/connectors/reload.
   *
   * This is what makes "save Slack tokens in WebUI → bot reconnects" work
   * without a daemon restart. Previously only instance-based connectors
   * were reloaded, so editing top-level slack tokens required `ryoko stop`
   * + `ryoko start`.
   */
  async function doReloadOnce(): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    const fresh = loadConfig();
    // Push fresh config into the SessionManager so new sessions see new
    // engines.default / portal.* / bin paths. Callers (watcher / API) are
    // responsible for updating apiContext.config too.
    currentConfig = fresh;
    sessionManager.setConfig(fresh);

    // Order:
    //   1. Stop old top-level + old instance connectors (clear the map).
    //   2. Start top-level FIRST (matches boot precedence: if a duplicate
    //      id exists in both forms, the legacy top-level wins).
    //   3. Start instances last — same `!connectorMap.has(...)` guard as
    //      boot, so duplicate-id instances are skipped, not the top-level.
    const stopTopRes = await stopTopLevelConnectors();
    const stopInstRes = await stopInstanceConnectors();
    const startTopRes = await startTopLevelConnectorsFromConfig(fresh);
    const startInstRes = await startConfiguredInstances(fresh);
    // Refresh the connector names baked into engine system prompts.
    sessionManager.setConnectorNames(Array.from(connectorMap.keys()));

    const result = {
      started: [...startTopRes.started, ...startInstRes.started],
      stopped: [...stopTopRes.stopped, ...stopInstRes.stopped],
      errors: [
        ...stopTopRes.errors,
        ...stopInstRes.errors,
        ...startTopRes.errors,
        ...startInstRes.errors,
      ],
    };

    // Only mark this config as "successfully applied" when no errors arose.
    // Otherwise the watcher's next event (after clearSuppressNextConnectorReload
    // in the API failure path) would diff fresh-vs-fresh and skip the retry.
    if (result.errors.length === 0) {
      lastConnectorReloadConfig = fresh;
    }
    return result;
  }

  async function reloadAllConnectors(): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    // Coalesce concurrent callers: if a reload is in flight, mark a follow-up
    // so newer config (the second caller's intent) gets picked up after the
    // current one completes — and return the in-flight promise's result.
    // Without this, two overlapping reloads can both observe an empty map
    // after their respective stop pass and start duplicate live clients.
    if (reloadInFlight) {
      pendingReload = true;
      return reloadInFlight;
    }
    reloadInFlight = (async () => {
      try {
        let result = await doReloadOnce();
        // Drain any reload requests that arrived during this run, with
        // the most recent on-disk config. Keep going until quiet.
        while (pendingReload) {
          pendingReload = false;
          result = await doReloadOnce();
        }
        return result;
      } finally {
        reloadInFlight = null;
      }
    })();
    return reloadInFlight;
  }

  // Start cron scheduler
  const cronJobs = loadJobs();
  startScheduler(cronJobs, sessionManager, config, connectorMap);
  logger.info(`Loaded ${cronJobs.length} cron job(s)`);

  // Mutable config reference for hot-reload
  let currentConfig = config;
  // Tracks the config version that was last successfully applied to connectors.
  // The watcher diffs against THIS (not currentConfig) so that a failed reload
  // does not poison the next chokidar event into thinking "nothing changed".
  let lastConnectorReloadConfig = config;

  // Single-flight gate for connector reloads: any caller that arrives while
  // one is in flight is coalesced (no duplicate clients), and any reload
  // request received during a run schedules a single follow-up so newer
  // config doesn't get lost.
  let reloadInFlight: Promise<{ started: string[]; stopped: string[]; errors: string[] }> | null = null;
  let pendingReload = false;

  // Coordination flag between the API config-save path and the file watcher.
  // PUT /api/config eagerly reloads connectors for snappy UX, then sets this
  // flag so the chokidar event for the same file write doesn't double-reload
  // and race against the in-flight reload.
  let suppressNextWatcherConnectorReload = false;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;
  function suppressNextConnectorReload(): void {
    suppressNextWatcherConnectorReload = true;
    if (suppressTimer) clearTimeout(suppressTimer);
    // Auto-clear after 3s in case the watcher event never arrives (the file
    // write was rolled back, chokidar missed it, etc.) — we don't want to
    // permanently suppress legitimate future reloads.
    suppressTimer = setTimeout(() => {
      suppressNextWatcherConnectorReload = false;
      suppressTimer = null;
    }, 3000);
  }
  function clearSuppressNextConnectorReload(): void {
    suppressNextWatcherConnectorReload = false;
    if (suppressTimer) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
  }

  const startTime = Date.now();

  // Broadcast function (defined early so apiContext can reference it)
  const wsClients = new Set<import("ws").WebSocket>();
  const emit = (event: string, payload: unknown): void => {
    const message = JSON.stringify({ event, payload, ts: Date.now() });
    for (const client of wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (err) {
          logger.warn(`WebSocket send failed, removing dead client: ${err instanceof Error ? err.message : err}`);
          wsClients.delete(client);
        }
      }
    }
  };

  // API context
  const apiContext: ApiContext = {
    config: currentConfig,
    sessionManager,
    startTime,
    getConfig: () => currentConfig,
    emit,
    connectors: connectorMap,
    reloadConnectorInstances,
    reloadAllConnectors,
    suppressNextConnectorReload,
    clearSuppressNextConnectorReload,
  };

  // Replay any pending web queue items (e.g. gateway restart mid-run)
  resumePendingWebQueueItems(apiContext);

  // Resolve web UI directory — bundled into dist/web/ by postbuild script
  // At runtime __dirname is dist/src/gateway/, so ../../web resolves to dist/web/
  const webDir = path.resolve(__dirname, "..", "..", "web");

  // Create HTTP server
  const server = http.createServer((req, res) => {
    const url = req.url || "/";

    // CORS headers for development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (url.startsWith("/api/")) {
      handleApiRequest(req, res, apiContext);
      return;
    }

    // Static files for web UI
    if (!serveStatic(req, res, webDir)) {
      if (url === "/" || url === "/index.html") {
        res.writeHead(503, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Web UI not built</h1><p>Run <code>pnpm build</code> from the project root to build the web UI.</p></body></html>");
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    }
  });

  // WebSocket server
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    logger.info(`WebSocket client connected (${wsClients.size} total)`);

    ws.on("close", () => {
      wsClients.delete(ws);
      logger.info(`WebSocket client disconnected (${wsClients.size} total)`);
    });

    ws.on("error", (err) => {
      logger.error(`WebSocket error: ${err.message}`);
      wsClients.delete(ws);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });


  // Sync skill symlinks to .claude/skills/ and .agents/skills/
  syncSkillSymlinks();

  // Initialize STT model symlinks
  try {
    initStt();
  } catch (err) {
    logger.warn(`STT init skipped: ${err instanceof Error ? err.message : err}`);
  }

  // Start file watchers
  startWatchers({
    onConfigReload: () => {
      try {
        const previous = currentConfig;
        currentConfig = loadConfig();
        apiContext.config = currentConfig;
        // Propagate the fresh config into SessionManager so new sessions
        // pick up edits to engines.default / portal.* / engine bin paths
        // even when the connectors block didn't change.
        sessionManager.setConfig(currentConfig);
        logger.info("Config reloaded successfully");
        emit("config:reloaded", {});

        // If the API just wrote this file (PUT /api/config) it has already
        // triggered reloadAllConnectors itself and may still be mid-reconnect.
        // Skip our reload to avoid stop→start→stop→start churn and the
        // race that comes with two overlapping reloads.
        if (suppressNextWatcherConnectorReload) {
          suppressNextWatcherConnectorReload = false;
          if (suppressTimer) {
            clearTimeout(suppressTimer);
            suppressTimer = null;
          }
          logger.debug("Skipping watcher-triggered connector reload (API just wrote config and reloaded)");
          return;
        }

        // External edits to ~/.ryoko/config.yaml (vim, ryoko CLI, etc.) need
        // a connector refresh when either:
        //   (a) the connectors block changed, OR
        //   (b) portal.portalName/operatorName changed — Slack connectors
        //       capture those at construction so the live ones would keep
        //       triaging with the old portal identity until restart.
        //
        // Diff against lastConnectorReloadConfig (NOT `previous`) so that a
        // failed previous reload doesn't poison this comparison: if the
        // last successful reload was config v1 and we've since written v2
        // unsuccessfully, comparing v2-vs-v2 would skip the retry.
        const baseline = lastConnectorReloadConfig;
        const portalNamesChanged =
          baseline.portal?.portalName !== currentConfig.portal?.portalName ||
          baseline.portal?.operatorName !== currentConfig.portal?.operatorName;
        const connectorsChanged =
          JSON.stringify(baseline.connectors ?? null) !==
          JSON.stringify(currentConfig.connectors ?? null);
        if (connectorsChanged || portalNamesChanged) {
          reloadAllConnectors()
            .then((result) => {
              logger.info(
                `Connectors reloaded after config change — started=[${result.started.join(",")}] stopped=[${result.stopped.join(",")}] errors=${result.errors.length}`,
              );
              emit("connectors:reloaded", result);
            })
            .catch((err) => {
              logger.error(
                `reloadAllConnectors failed: ${err instanceof Error ? err.message : err}`,
              );
            });
        }
      } catch (err) {
        logger.error(
          `Failed to reload config: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    onCronReload: () => {
      const updatedJobs = loadJobs();
      reloadScheduler(updatedJobs);
      logger.info(`Cron jobs reloaded (${updatedJobs.length} job(s))`);
      emit("cron:reloaded", {});
    },
    onOrgChange: () => {
      employeeRegistry = scanOrg();
      logger.info(`Org directory changed, reloaded ${employeeRegistry.size} employee(s)`);
      emit("org:changed", {});
    },
    onSkillsChange: () => {
      logger.info("Skills changed, notifying clients");
      emit("skills:changed", {});
    },
  });

  // Start listening
  const port = config.gateway.port || 7777;
  const host = config.gateway.host || "127.0.0.1";

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const msg = `Port ${port} is already in use.`;
        logger.error(msg);
        console.error(`\nError: ${msg}`);
        console.error(`\nTry: ryoko start -p ${port + 1}`);
        console.error(`Or update the port in config.yaml\n`);
        process.exit(1);
      }
      reject(err);
    });
    server.listen(port, host, () => {
      logger.info(`${gatewayName} gateway listening on http://${host}:${port} (boot ${bootId})`);
      resolve();
    });
  });

  // Notify connected WebSocket clients about interrupted sessions available for resume
  if (resumable.length > 0) {
    // Small delay to let WebSocket clients connect after server starts
    setTimeout(() => {
      emit("sessions:interrupted", {
        count: resumable.length,
        sessions: resumable.map((s) => ({
          id: s.id,
          engine: s.engine,
          employee: s.employee,
          title: s.title,
          lastActivity: s.lastActivity,
        })),
      });
    }, 1000);
  }

  // Prevent macOS from sleeping while the gateway is running
  let caffeinate: ChildProcess | null = null;
  if (process.platform === "darwin") {
    caffeinate = spawn("caffeinate", ["-s"], {
      stdio: "ignore",
      detached: false,
    });
    caffeinate.unref();
    caffeinate.on("error", (err) => {
      logger.warn(`caffeinate failed to start: ${err.message}`);
      caffeinate = null;
    });
    logger.info("caffeinate started — macOS sleep prevention active");
  }

  // Return cleanup function
  return async () => {
    logger.info("Gateway cleanup starting...");

    // Stop caffeinate
    if (caffeinate && caffeinate.exitCode === null) {
      caffeinate.kill();
      logger.info("caffeinate stopped");
    }

    // Mark all running sessions as "interrupted" before killing engine processes.
    // This preserves their engine_session_id so they can be resumed on next startup.
    const runningSessions = listSessions({ status: "running" });
    for (const session of runningSessions) {
      updateSession(session.id, {
        status: "interrupted",
        lastActivity: new Date().toISOString(),
        lastError: "Interrupted: gateway shutting down gracefully",
      });
      logger.info(`Marked session ${session.id} as interrupted for resume`);
    }

    // Terminate live engine subprocesses after marking sessions.
    claudeEngine.killAll();
    codexEngine.killAll();

    // Stop cron scheduler
    stopScheduler();

    // Stop connectors
    for (const connector of connectors) {
      try {
        await connector.stop();
      } catch (err) {
        logger.error(`Failed to stop ${connector.name} connector: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Stop watchers
    await stopWatchers();

    // Close WebSocket connections
    for (const client of wsClients) {
      client.close(1001, "Server shutting down");
    }
    wsClients.clear();

    // Close WebSocket server
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info("Gateway shutdown complete");
  };
}
