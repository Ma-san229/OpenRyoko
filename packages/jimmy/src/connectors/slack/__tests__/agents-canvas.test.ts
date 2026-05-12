import { describe, it, expect } from "vitest";
import { renderCanvasMarkdown } from "../agents-canvas.js";
import type { Session } from "../../../shared/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    engine: "claude",
    engineSessionId: "claude-abc",
    source: "slack",
    sourceRef: "C123:1700000000.000",
    connector: "slack",
    sessionKey: "slack:C123",
    replyContext: null,
    messageId: "1700000000.000",
    transportMeta: null,
    employee: null,
    model: null,
    title: "Untitled",
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    createdAt: "2026-05-13T01:00:00.000Z",
    lastActivity: "2026-05-13T01:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

const FIXED_NOW = Date.parse("2026-05-13T01:30:00.000Z");

describe("renderCanvasMarkdown", () => {
  it("renders a placeholder when there are no sessions", () => {
    const md = renderCanvasMarkdown([], { nowMs: FIXED_NOW });
    expect(md).toContain("# Ryoko Agents View");
    expect(md).toContain("0 sessions");
    expect(md).toContain("No active sessions");
  });

  it("groups sessions by status", () => {
    const sessions = [
      makeSession({ id: "a", status: "running", title: "Build proposal" }),
      makeSession({ id: "b", status: "waiting", title: "Awaiting reply" }),
      makeSession({ id: "c", status: "error", title: "Broken thing", lastError: "boom" }),
      makeSession({ id: "d", status: "interrupted", title: "Old run" }),
      makeSession({ id: "e", status: "idle", title: "Wrapped up" }),
    ];
    const md = renderCanvasMarkdown(sessions, { nowMs: FIXED_NOW });
    expect(md).toContain("🟢 Running (1)");
    expect(md).toContain("🟡 Waiting on you (1)");
    expect(md).toContain("🔴 Errored (1)");
    expect(md).toContain("⏸️ Interrupted (resumable) (1)");
    expect(md).toContain("✅ Recently idle (1)");
    expect(md).toContain("**Build proposal**");
    expect(md).toContain("**Awaiting reply**");
  });

  it("omits empty groups", () => {
    const sessions = [makeSession({ status: "running", title: "Just one" })];
    const md = renderCanvasMarkdown(sessions, { nowMs: FIXED_NOW });
    expect(md).toContain("🟢 Running (1)");
    expect(md).not.toContain("Waiting on you");
    expect(md).not.toContain("Errored");
    expect(md).not.toContain("Recently idle");
  });

  it("caps each group at maxPerGroup and shows overflow line", () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      makeSession({ id: `r${i}`, status: "running", title: `task ${i}` }),
    );
    const md = renderCanvasMarkdown(sessions, { nowMs: FIXED_NOW, maxPerGroup: 3 });
    expect(md).toContain("🟢 Running (15)");
    expect(md).toContain("**task 0**");
    expect(md).toContain("**task 2**");
    expect(md).not.toContain("**task 3**");
    expect(md).toContain("…and 12 more");
  });

  it("formats age in minutes / hours / days", () => {
    const sessions = [
      makeSession({
        id: "fresh",
        status: "running",
        title: "fresh",
        lastActivity: new Date(FIXED_NOW - 2 * 60_000).toISOString(),
      }),
      makeSession({
        id: "old",
        status: "running",
        title: "hours-old",
        lastActivity: new Date(FIXED_NOW - 3 * 60 * 60_000).toISOString(),
      }),
      makeSession({
        id: "ancient",
        status: "running",
        title: "days-old",
        lastActivity: new Date(FIXED_NOW - 5 * 24 * 60 * 60_000).toISOString(),
      }),
    ];
    const md = renderCanvasMarkdown(sessions, { nowMs: FIXED_NOW });
    expect(md).toContain("**fresh**");
    expect(md).toMatch(/\*\*fresh\*\*.* — 2m/);
    expect(md).toMatch(/\*\*hours-old\*\*.* — 3h/);
    expect(md).toMatch(/\*\*days-old\*\*.* — 5d/);
  });

  it("truncates very long titles", () => {
    const longTitle = "x".repeat(200);
    const md = renderCanvasMarkdown(
      [makeSession({ title: longTitle, status: "running" })],
      { nowMs: FIXED_NOW },
    );
    expect(md).toContain("…");
    // Should not include the full 200 chars
    expect(md).not.toContain(longTitle);
  });

  it("honors a custom title", () => {
    const md = renderCanvasMarkdown([], { title: "Team Ryoko", nowMs: FIXED_NOW });
    expect(md).toContain("# Team Ryoko");
  });

  it("includes connector/employee in the line metadata when present", () => {
    const md = renderCanvasMarkdown(
      [
        makeSession({
          status: "running",
          title: "with-meta",
          connector: "slack",
          source: "slack",
          employee: "ryoko",
        }),
      ],
      { nowMs: FIXED_NOW },
    );
    expect(md).toContain("**with-meta** _(slack · @ryoko)_");
  });
});
