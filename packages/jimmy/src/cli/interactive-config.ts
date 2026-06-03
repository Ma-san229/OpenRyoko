import fs from "node:fs";
import readline from "node:readline";
import { CONFIG_PATH } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Read engines.claude.interactive from config.yaml.
 * Returns undefined when the key is absent (= the user hasn't decided yet) or
 * when the config can't be read — callers treat undefined as "not configured".
 */
export function getInteractiveSetting(): boolean | undefined {
  try {
    const cfg = loadConfig() as { engines?: { claude?: { interactive?: boolean } } };
    return cfg.engines?.claude?.interactive;
  } catch {
    return undefined;
  }
}

/**
 * Set engines.claude.interactive in config.yaml via a LINE-BASED edit so the
 * file's comments + formatting survive (a yaml.dump round-trip would strip them).
 * Only the `claude` engine carries an `interactive:` key, so the first live or
 * commented match is unambiguous; otherwise the key is inserted under `claude:`.
 * Returns true if the file changed.
 */
export function setInteractiveSetting(enabled: boolean): boolean {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const lines = raw.split("\n");

  // 1) An existing LIVE line — flip its value in place (keep any trailing comment).
  const liveIdx = lines.findIndex((l) => /^\s*interactive:\s*(true|false)\s*(#.*)?$/.test(l));
  if (liveIdx >= 0) {
    const next = lines[liveIdx].replace(/interactive:\s*(true|false)/, `interactive: ${enabled}`);
    if (next === lines[liveIdx]) return false;
    lines[liveIdx] = next;
    fs.writeFileSync(CONFIG_PATH, lines.join("\n"), "utf-8");
    return true;
  }

  // 2) A COMMENTED hint (template default) — uncomment + set, preserving indent.
  const commentedIdx = lines.findIndex((l) => /^\s*#\s*interactive:\s*(true|false)\s*$/.test(l));
  if (commentedIdx >= 0) {
    const indent = lines[commentedIdx].match(/^(\s*)/)?.[1] ?? "    ";
    lines[commentedIdx] = `${indent}interactive: ${enabled}`;
    fs.writeFileSync(CONFIG_PATH, lines.join("\n"), "utf-8");
    return true;
  }

  // 3) Neither present — insert under the `  claude:` block (2-space nesting).
  const claudeIdx = lines.findIndex((l) => /^\s{2}claude:\s*$/.test(l));
  if (claudeIdx < 0) throw new Error("engines.claude block not found in config.yaml");
  lines.splice(claudeIdx + 1, 0, `    interactive: ${enabled}`);
  fs.writeFileSync(CONFIG_PATH, lines.join("\n"), "utf-8");
  return true;
}

function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? ` ${DIM}[Y/n]${RESET}` : ` ${DIM}[y/N]${RESET}`;
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") return resolve(defaultYes);
      resolve(a === "y" || a === "yes");
    });
  });
}

/**
 * Offer to enable the interactive (PTY) Claude engine, then persist the choice.
 *
 * - Skips silently in non-interactive shells (CI / cron / piped) — never blocks
 *   an automated `ryoko update`.
 * - By default only asks when the user hasn't decided yet (key absent). Pass
 *   `{ force: true }` to re-ask even when already set (e.g. fresh `ryoko setup`).
 */
export async function promptInteractive(opts: { force?: boolean } = {}): Promise<void> {
  if (!process.stdin.isTTY) return;
  const current = getInteractiveSetting();
  if (!opts.force && current !== undefined) return;

  console.log("");
  console.log(`  ${YELLOW}Claude をインタラクティブ PTY で動かしますか？${RESET}`);
  console.log(`  ${DIM}ON にすると Claude の作業ターンを PTY（cc_entrypoint=cli）で実行し、Max${RESET}`);
  console.log(`  ${DIM}サブスクリプション課金になります（API 従量課金を回避）。${RESET}`);
  console.log(`  ${DIM}注意: SSH リモート実行の従業員は headless 'claude -p' にフォールバックします。${RESET}`);
  console.log(`  ${DIM}OFF（既定）は従来どおり headless 'claude -p'。後から 'ryoko config interactive on|off' で変更可。${RESET}`);

  const enable = await askYesNo("有効にしますか？", current === true);
  const changed = setInteractiveSetting(enable);
  if (changed) {
    console.log(`  ${GREEN}interactive を ${enable ? "on" : "off"} に設定しました。${RESET} ${DIM}ゲートウェイ再起動で反映されます。${RESET}`);
  } else {
    console.log(`  ${DIM}interactive は既に ${enable ? "on" : "off"} です。${RESET}`);
  }
  console.log("");
}
