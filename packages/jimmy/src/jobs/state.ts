import fs from "node:fs";
import path from "node:path";
import { JOBS_DIR } from "../shared/paths.js";

/**
 * Detached-job state files (issue #38 follow-up).
 *
 * One JSON file per job under `~/.jinn/jobs/<id>.json`. The lifecycle is:
 *
 *   running → exited → notified          (happy path)
 *                    → notify_failed     (gateway unreachable after retries)
 *
 * The file is written by `ryoko job run` (creation) and the detached monitor
 * process (every later transition). The gateway only READS these files (the
 * context builder surfaces finished-but-unnotified jobs on the next turn), so
 * a job can never be lost silently even if its wake-up notification failed.
 */

export type JobStatus = "running" | "exited" | "notified" | "notify_failed";

export interface JobState {
  id: string;
  name: string;
  /** Gateway session to wake when the job finishes. */
  sessionId: string;
  /** Loopback gateway base URL, e.g. http://127.0.0.1:7777 */
  gatewayUrl: string;
  /** The shell command the monitor runs via `sh -c`. */
  command: string;
  logFile: string;
  /** PID of the detached monitor process (its own process group leader). */
  monitorPid: number;
  startedAt: string;
  timeoutSec?: number;
  status: JobStatus;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  finishedAt?: string;
  notifiedAt?: string;
  notifyError?: string;
}

export function jobStatePath(id: string, jobsDir: string = JOBS_DIR): string {
  return path.join(jobsDir, `${id}.json`);
}

export function writeJobState(state: JobState, jobsDir: string = JOBS_DIR): void {
  fs.mkdirSync(jobsDir, { recursive: true });
  const file = jobStatePath(state.id, jobsDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function readJobState(id: string, jobsDir: string = JOBS_DIR): JobState | null {
  try {
    const raw = fs.readFileSync(jobStatePath(id, jobsDir), "utf8");
    const parsed = JSON.parse(raw) as JobState;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.status !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listJobStates(jobsDir: string = JOBS_DIR): JobState[] {
  let files: string[];
  try {
    files = fs.readdirSync(jobsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const states: JobState[] = [];
  for (const f of files) {
    const state = readJobState(path.basename(f, ".json"), jobsDir);
    if (state) states.push(state);
  }
  states.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return states;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A job needs the agent's attention when it finished but the wake-up
 * notification could not be delivered (gateway down at the time), or when it
 * claims to be running but its monitor process is dead (machine reboot,
 * kill -9): without this, an orphaned job would be "起こされないまま放置".
 */
export type JobAttention =
  | { kind: "unnotified"; state: JobState }
  | { kind: "orphaned"; state: JobState };

export function findJobsNeedingAttention(jobsDir: string = JOBS_DIR): JobAttention[] {
  const out: JobAttention[] = [];
  for (const state of listJobStates(jobsDir)) {
    if (state.status === "exited" || state.status === "notify_failed") {
      out.push({ kind: "unnotified", state });
    } else if (state.status === "running" && !isPidAlive(state.monitorPid)) {
      out.push({ kind: "orphaned", state });
    }
  }
  return out;
}

const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Remove terminal-state job files older than a week. Opportunistic cleanup. */
export function pruneOldJobs(jobsDir: string = JOBS_DIR, nowMs: number = Date.now()): number {
  let pruned = 0;
  for (const state of listJobStates(jobsDir)) {
    if (state.status !== "notified" && state.status !== "notify_failed") continue;
    const ts = new Date(state.finishedAt ?? state.startedAt).getTime();
    if (Number.isFinite(ts) && nowMs - ts > PRUNE_AFTER_MS) {
      try {
        fs.unlinkSync(jobStatePath(state.id, jobsDir));
        pruned++;
      } catch {
        // already gone
      }
    }
  }
  return pruned;
}
