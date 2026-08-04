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

  it("includes the process lifetime warning as an essential section", () => {
    const ctx = buildContext(baseOpts);
    expect(ctx).toContain("## Process lifetime");
    expect(ctx).toContain("background tasks die when your turn ends");
    expect(ctx).toContain("setsid nohup");
  });

  it("tells the agent to verify detached jobs via logfile in a later turn", () => {
    const ctx = buildContext(baseOpts);
    expect(ctx).toMatch(/LATER turn/);
    expect(ctx).toMatch(/logfile/i);
  });

  it("survives aggressive trimming (essential tier is never dropped)", () => {
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
      context: { maxChars: 4000 },
    };
    const ctx = buildContext({
      ...baseOpts,
      config: stubConfig as never,
      connectors: ["slack"],
    });
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx).toContain("## Process lifetime");
  });
});
