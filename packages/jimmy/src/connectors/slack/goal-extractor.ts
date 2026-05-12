/**
 * Natural-language `/goal` extraction for Slack messages.
 *
 * Lives outside the triage path on purpose: triage = "should we respond at
 * all" (only meaningful when ambient noise might NOT be for us). When the
 * message clearly IS for us (DM / @-mention / DM-equivalent / triage→reply),
 * triage is bypassed but we still want to recognise autonomous-completion
 * intent and prefix `/goal <cond>` to the engine prompt so Claude Code's
 * v2.1.139 Stop hook keeps the session working until the goal holds.
 *
 * Two stages keep latency and cost down:
 *
 *   1. `hasGoalIntent` — deterministic keyword gate. Burns no LLM credits.
 *      Catches the common JP / EN "keep going until done" phrasings.
 *   2. `extractGoalCondition` — only fires when (1) matches. Spawns Haiku
 *      via the Claude Code CLI with a tight prompt and a hard timeout.
 *      On any failure (timeout, unparseable output, slash-prefix rejection)
 *      it returns `null` and the caller pretends nothing happened.
 *
 * All sanitisation lives in `parseGoalExtractionResult` so it is unit-
 * testable without spawning a subprocess.
 */

import { spawn } from "node:child_process";
import { logger } from "../../shared/logger.js";
import { resolveBin, formatSpawnError } from "../../shared/resolveBin.js";
import { buildChildEnv } from "../../shared/childEnv.js";

// ---------------------------------------------------------------------------
// Keyword gate
// ---------------------------------------------------------------------------

/**
 * JP/EN phrases that indicate the user wants Claude to keep working
 * autonomously until a specific outcome holds. Tuned for high recall on the
 * obvious cases — false-positives are bounded by the Haiku step that
 * follows, which can still refuse to extract a condition.
 */
const GOAL_INTENT_RE = new RegExp(
  [
    // Japanese — "keep going / don't stop until done"
    "止まらないで",
    "止まらず",
    "止めないで",
    "完成するまで",
    "完了するまで",
    "終わるまで",
    "(?:完成|完了|終わ)(?:し|っ)?たら(?:教|報告|連絡|Slack|スラック)",
    "全部終わ",
    "最後まで(?:やっ|頑張|完遂|動)",
    "ノンストップで",
    "自律的に(?:最後|完成|完了)",
    // English
    "keep going",
    "don'?t stop",
    "until (?:done|complete|finish|finished|it'?s done|you finish)",
    "finish (?:it|the whole|the entire)",
    "go all the way",
  ].join("|"),
  "i",
);

export function hasGoalIntent(text: string): boolean {
  if (!text) return false;
  return GOAL_INTENT_RE.test(text);
}

// ---------------------------------------------------------------------------
// Prompt builder (pure)
// ---------------------------------------------------------------------------

const MAX_MESSAGE_CHARS = 2000;

export function buildGoalExtractionPrompt(messageText: string): string {
  const truncated = messageText.length > MAX_MESSAGE_CHARS
    ? messageText.slice(0, MAX_MESSAGE_CHARS) + "\n…(truncated)"
    : messageText;

  return `You distill the OBJECTIVE completion condition from a user's
message into a single short sentence so a downstream agent can self-check
when it is done.

# Input
The user has sent this message to an AI assistant:
"""
${truncated}
"""

The message has already been flagged (via deterministic keyword matching) as
expressing autonomous-completion intent — language like "完成するまで止まらな
いで動いて", "終わったらSlackで教えて", "keep going until done", etc.

# What to produce
Output EXACTLY ONE JSON object, nothing else. No markdown, no prose, no code
fences. Schema:

  {"condition": "<one short sentence stating the final state>"}

or, if no objective condition can be distilled:

  {"condition": null}

# Rules for "condition"
- A single sentence describing the final STATE that, once true, means the
  task is done. NOT the steps to get there.
- Self-checkable from the assistant's own work or its tool outputs. Avoid
  conditions that require human judgement (e.g. "the user is satisfied").
- Concrete and specific. Echo concrete nouns/numbers from the user's
  message (counts, target docs, channels, file names) when present.
- One sentence, English or Japanese, <= 200 characters. No newlines, no
  bullet lists.
- MUST NOT start with a slash — do not produce another slash command.
- If the user's request is too vague to have a checkable end state, output
  {"condition": null}.

# Examples
User: "5社の人事SaaSの料金/機能を比較した表をこのスレッドに投げて、完成するまで止まらないで"
→ {"condition": "Posted a Markdown table comparing the pricing and features of five HR SaaS products to this Slack thread."}

User: "ちょっと聞きたいんだけど、完成するまで頑張ってみる？"
→ {"condition": null}

User: "プロジェクトAの全タスクをLinearで close するまで動いて、終わったら教えて"
→ {"condition": "Closed every open task under project A in Linear."}

# Output
Produce the JSON object now. JSON only.`;
}

// ---------------------------------------------------------------------------
// Result parser (pure)
// ---------------------------------------------------------------------------

const MAX_CONDITION_CHARS = 400;
// Built via new RegExp so the source text is plain ASCII — embedding raw
// control bytes in a regex literal trips some editor / tool pipelines.
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/**
 * Parse Haiku's response into a sanitised condition, or null if no usable
 * condition was returned. Sanitisation:
 *   - strip control characters, collapse whitespace
 *   - reject leading `/` (would smuggle a second slash command)
 *   - reject obviously vague placeholders
 *   - hard cap on length
 */
export function parseGoalExtractionResult(raw: string): string | null {
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const value = (parsed as Record<string, unknown>).condition;
  if (typeof value !== "string") return null;

  const flat = value.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.startsWith("/")) return null;

  // Reject obvious sentinels that the LLM might still produce despite
  // being asked for null.
  const lower = flat.toLowerCase();
  if (
    lower === "none" ||
    lower === "n/a" ||
    lower === "null" ||
    lower === "unknown" ||
    lower === "tbd" ||
    lower.startsWith("the user is")
  ) {
    return null;
  }

  return flat.slice(0, MAX_CONDITION_CHARS);
}

// ---------------------------------------------------------------------------
// Haiku invocation
// ---------------------------------------------------------------------------

export interface ExtractGoalOptions {
  /** Binary to invoke — defaults to "claude" */
  bin?: string;
  /** Model to call — defaults to claude-haiku-4-5 */
  model?: string;
  /** Hard timeout before giving up (ms). Defaults to 15s. */
  timeoutMs?: number;
  /** Override the spawner (for tests) */
  spawnImpl?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_BIN = "claude";

/**
 * Extract a `/goal` condition from a user's message. Returns null on any
 * failure — the caller should treat this as "don't inject /goal" and move
 * on. Never throws.
 */
export async function extractGoalCondition(
  messageText: string,
  options: ExtractGoalOptions = {},
): Promise<string | null> {
  if (!hasGoalIntent(messageText)) return null;

  const bin = options.bin || DEFAULT_BIN;
  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = options.spawnImpl || spawn;
  const prompt = buildGoalExtractionPrompt(messageText);

  try {
    const output = await invokeClaude(prompt, { bin, model, timeoutMs, spawnFn });
    return parseGoalExtractionResult(output);
  } catch (err) {
    logger.warn(`[goal-extractor] extraction failed, skipping /goal: ${err}`);
    return null;
  }
}

interface InvokeOptions {
  bin: string;
  model: string;
  timeoutMs: number;
  spawnFn: typeof spawn;
}

function invokeClaude(prompt: string, opts: InvokeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      opts.model,
      "--dangerously-skip-permissions",
      prompt,
    ];
    const resolvedBin = resolveBin(opts.bin);
    const proc = opts.spawnFn(resolvedBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildChildEnv(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(new Error(`goal-extractor timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(formatSpawnError("goal-extractor CLI", opts.bin, err)));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(extractClaudeResult(stdout));
    });
  });
}

function extractClaudeResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.result === "string") {
      return parsed.result;
    }
  } catch {
    /* fall through */
  }
  return trimmed;
}
