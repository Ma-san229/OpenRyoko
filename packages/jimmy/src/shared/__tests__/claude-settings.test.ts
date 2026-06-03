import { describe, it, expect } from "vitest";
import { buildSessionSettings } from "../claude-settings.js";

describe("buildSessionSettings", () => {
  it("registers SessionStart/Stop/StopFailure/PreToolUse/PostToolUse hooks", () => {
    const s = buildSessionSettings({ sessionId: "abc", relayScript: "/home/.ryoko/hook-relay.mjs" });
    for (const ev of ["SessionStart", "Stop", "StopFailure", "PreToolUse", "PostToolUse"] as const) {
      expect(s.hooks[ev]).toHaveLength(1);
      expect(s.hooks[ev][0].hooks[0].type).toBe("command");
    }
  });

  it("shell-quotes the relay script path and session id (path with spaces)", () => {
    const s = buildSessionSettings({
      sessionId: "sess-1",
      relayScript: "/Users/My User/.ryoko/hook-relay.mjs",
    });
    const cmd = s.hooks.Stop[0].hooks[0].command;
    // The space-bearing path must be single-quoted so the shell sees one argument.
    expect(cmd).toBe("node '/Users/My User/.ryoko/hook-relay.mjs' 'sess-1'");
  });

  it("neutralizes shell metacharacters in the path (no injection)", () => {
    const s = buildSessionSettings({
      sessionId: "x",
      relayScript: "/tmp/a'; rm -rf ~; '.mjs",
    });
    const cmd = s.hooks.Stop[0].hooks[0].command;
    // The embedded single quote is escaped as '\'' so the injected `rm` is inert text.
    expect(cmd).toContain(`'/tmp/a'\\''; rm -rf ~; '\\''.mjs'`);
    expect(cmd.startsWith("node '")).toBe(true);
  });

  it("includes appendSystemPrompt only when provided", () => {
    const without = buildSessionSettings({ sessionId: "a", relayScript: "/r.mjs" });
    expect(without.appendSystemPrompt).toBeUndefined();
    const withPrompt = buildSessionSettings({ sessionId: "a", relayScript: "/r.mjs", appendSystemPrompt: "be terse" });
    expect(withPrompt.appendSystemPrompt).toBe("be terse");
  });
});
