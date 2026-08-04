import fs from "node:fs";
import { spawn } from "node:child_process";
import { readJobState, writeJobState, type JobState } from "./state.js";
import { buildJobNotification, readLogTail, sendJobNotification, type NotifyDeps } from "./notify.js";

/**
 * Detached job monitor — the process `ryoko job run` spawns into its own
 * process group (survives the engine turn ending and gateway restarts).
 *
 * It runs the job command, streams output to the logfile, and when the job
 * exits — success, failure or timeout — wakes the originating session exactly
 * once via the gateway notification route. All state transitions are persisted
 * to the job state file so an orphaned job is detectable on the next turn.
 */

const KILL_GRACE_MS = 10_000;

export interface MonitorDeps extends NotifyDeps {
  jobsDir?: string;
}

export async function runJobMonitor(jobId: string, deps: MonitorDeps = {}): Promise<JobState | null> {
  const jobsDir = deps.jobsDir;
  const state = readJobState(jobId, jobsDir);
  if (!state) return null;
  // A monitor restart must never re-run the command or double-notify.
  if (state.status !== "running") return state;

  const exit = await runJobCommand(state);

  const exited: JobState = {
    ...state,
    status: "exited",
    exitCode: exit.code,
    signal: exit.signal,
    timedOut: exit.timedOut,
    finishedAt: new Date().toISOString(),
  };
  writeJobState(exited, jobsDir);

  const message = buildJobNotification(exited, readLogTail(exited.logFile));
  const sent = await sendJobNotification(exited, message, deps);

  const final: JobState = sent.ok
    ? { ...exited, status: "notified", notifiedAt: new Date().toISOString() }
    : { ...exited, status: "notify_failed", notifyError: sent.error };
  writeJobState(final, jobsDir);
  return final;
}

function runJobCommand(state: JobState): Promise<{ code: number | null; signal: string | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const logFd = fs.openSync(state.logFile, "a");
    const child = spawn("/bin/sh", ["-c", state.command], {
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });

    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    if (state.timeoutSec && state.timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
        killTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, KILL_GRACE_MS);
      }, state.timeoutSec * 1000);
    }

    child.on("exit", (code, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      resolve({ code, signal, timedOut });
    });
    child.on("error", (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      try { fs.appendFileSync(state.logFile, `\n[job-monitor] failed to spawn command: ${err.message}\n`); } catch { /* best effort */ }
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      resolve({ code: 127, signal: null, timedOut });
    });
  });
}
