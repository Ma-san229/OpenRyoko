import { describe, it, expect } from "vitest";
import { buildContext } from "../context.js";

// Issue #38: background tasks are killed with the one-shot engine process when
// the turn ends. The agent must be told this up front (option A), otherwise it
// confidently promises "I'll report back later" and the job dies silently.
describe("buildContext — process lifetime section", () => {
  const baseOpts = {
    source: "slack",
    channel: "C123",
    user: "U123",
  };

  const stubConfig = {
    jinn: { version: "0.0.0" },
    gateway: { port: 7777, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "" },
      codex: { bin: "codex", model: "" },
    },
    connectors: {},
    logging: { level: "info", stdout: false, file: "" },
  };

  it("warns about one-shot process death by default", () => {
    const ctx = buildContext(baseOpts);
    expect(ctx).toContain("## Process lifetime");
    expect(ctx).toContain("background tasks die when your turn ends");
    expect(ctx).toContain("Your process is one-shot");
  });

  it("gives OS-specific detach commands (setsid is Linux-only)", () => {
    const ctx = buildContext(baseOpts);
    expect(ctx).toContain("setsid nohup");
    expect(ctx).toMatch(/macOS/);
    expect(ctx).toMatch(/disown/);
  });

  it("says the agent cannot be woken up and must verify before reporting done", () => {
    const ctx = buildContext(baseOpts);
    expect(ctx).toContain("You will NOT be notified");
    expect(ctx).toMatch(/never claim completion you have not verified/i);
  });

  it("does not claim one-shot death for persistent (interactive PTY) sessions", () => {
    const ctx = buildContext({ ...baseOpts, processLifetime: "persistent" });
    expect(ctx).not.toContain("Your process is one-shot");
    expect(ctx).toContain("## Process lifetime");
    expect(ctx).toContain("persistent interactive process");
    // Detach guidance still applies: the PTY dies with the session/gateway.
    expect(ctx).toContain("setsid nohup");
  });

  it("is essential tier: full content survives trimming that summarizes standard sections", () => {
    const ctx = buildContext({
      ...baseOpts,
      config: { ...stubConfig, context: { maxChars: 2000 } } as never,
      connectors: ["slack"],
    });
    // A standard-tier section (connectors) collapsed to its summary…
    expect(ctx).not.toContain("**Send message**");
    // …while the full lifetime warning (this phrase is absent from any
    // summary) must remain intact.
    expect(ctx).toContain("NEVER start a plain background job");
  });
});
