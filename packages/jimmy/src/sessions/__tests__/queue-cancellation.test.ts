import { describe, it, expect } from "vitest";
import { SessionQueue } from "../queue.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("SessionQueue generational cancellation", () => {
  it("clearQueue cancels already-queued tasks but NOT tasks enqueued afterward", async () => {
    const queue = new SessionQueue();
    let releaseFirst: (() => void) | undefined;
    let bRan = false;
    let cRan = false;

    // A is running and held open.
    const first = queue.enqueue("slack:C1", async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    while (!queue.isRunning("slack:C1")) await tick();

    // B is queued behind the running A.
    const second = queue.enqueue("slack:C1", async () => { bRan = true; });

    // /stop (or the nightly watchdog reset): cancel everything queued so far.
    queue.clearQueue("slack:C1");

    // A new inbound message arrives AFTER the reset — it must still run.
    const third = queue.enqueue("slack:C1", async () => { cRan = true; });

    releaseFirst?.();
    await Promise.allSettled([first, second, third]);

    expect(bRan).toBe(false); // cancelled by clearQueue — not revived by the later message
    expect(cRan).toBe(true);  // newer generation → runs (recovery without a sticky mute)
  });

  it("a session reset while idle still runs the next inbound message (no permanent mute)", async () => {
    const queue = new SessionQueue();
    // Watchdog resets an idle session (the bug: this used to mute it forever).
    queue.clearQueue("slack:C2");
    let ran = false;
    await queue.enqueue("slack:C2", async () => { ran = true; });
    expect(ran).toBe(true);
  });
});
