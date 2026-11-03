import { describe, expect, test } from "bun:test";

import { createBoundedQueue } from "./bounded-queue.ts";

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

function queue(maxLength: number, concurrency: number) {
  const ran: number[] = [];
  const errors: unknown[] = [];
  const overflows: number[] = [];
  const gates = new Map<number, ReturnType<typeof gate>>();
  let running = 0;
  let peak = 0;
  const bounded = createBoundedQueue<number>({
    maxLength,
    concurrency,
    run: async (job) => {
      peak = Math.max(peak, ++running);
      ran.push(job);
      if (job < 0) {
        running--;
        throw new Error(`job ${job}`);
      }
      const held = gate();
      gates.set(job, held);
      await held.opened;
      running--;
    },
    onError: (error) => errors.push(error),
    onOverflow: (dropped) => overflows.push(dropped),
  });
  const started = async (count: number) => {
    while (ran.length < count) await Bun.sleep(1);
  };
  return {
    ...bounded,
    ran,
    errors,
    overflows,
    started,
    peak: () => peak,
    finish: (job: number) => gates.get(job)!.open(),
    finishAll: () => {
      for (const held of gates.values()) held.open();
    },
  };
}

describe("a bounded queue", () => {
  test("nothing starts in the turn that queued it", async () => {
    const q = queue(5, 5);
    q.enqueue(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(q.ran).toEqual([]);
    await q.started(1);
    q.finishAll();
    await q.drain(1_000);
  });

  test("never runs more than its concurrency, and runs in order", async () => {
    const q = queue(100, 3);
    for (let job = 1; job <= 10; job++) expect(q.enqueue(job)).toBe(true);
    await q.started(3);
    await Bun.sleep(5);
    expect(q.ran).toEqual([1, 2, 3]);
    expect(q.peak()).toBe(3);
    const draining = q.drain(5_000);
    for (let job = 1; job <= 10; job++) {
      await q.started(job);
      q.finish(job);
    }
    expect(await draining).toEqual({ abandoned: 0, running: 0 });
    expect(q.ran).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(q.peak()).toBe(3);
  });

  test("at its length it drops and counts, and takes more once there is room", async () => {
    const q = queue(2, 1);
    expect(q.enqueue(1)).toBe(true);
    await q.started(1);
    // Job 1 runs, so two may wait.
    expect(q.enqueue(2)).toBe(true);
    expect(q.enqueue(3)).toBe(true);
    expect(q.enqueue(4)).toBe(false);
    expect(q.enqueue(5)).toBe(false);
    expect(q.overflows).toEqual([1, 2]);
    q.finish(1);
    await q.started(2);
    expect(q.enqueue(6)).toBe(true);
    q.finish(2);
    await q.started(3);
    q.finish(3);
    await q.started(4);
    q.finish(6);
    expect(await q.drain(1_000)).toEqual({ abandoned: 0, running: 0 });
    expect(q.ran).toEqual([1, 2, 3, 6]);
  });

  test("a job that throws harms nothing else", async () => {
    const q = queue(5, 1);
    q.enqueue(-1);
    q.enqueue(1);
    q.enqueue(-2);
    q.enqueue(2);
    const draining = q.drain(1_000);
    await q.started(2);
    q.finish(1);
    await q.started(4);
    q.finish(2);
    expect(await draining).toEqual({ abandoned: 0, running: 0 });
    expect(q.errors.map((error) => (error as Error).message)).toEqual([
      "job -1",
      "job -2",
    ]);
  });

  test("a job that throws before its first await is one more error", async () => {
    const errors: unknown[] = [];
    const bounded = createBoundedQueue<number>({
      maxLength: 1,
      concurrency: 1,
      run: () => {
        throw new Error("at once");
      },
      onError: (error) => errors.push(error),
      onOverflow: () => {},
    });
    bounded.enqueue(1);
    expect(await bounded.drain(1_000)).toEqual({ abandoned: 0, running: 0 });
    expect(errors).toHaveLength(1);
  });

  test("the drain finishes what waits, and takes nothing new", async () => {
    const q = queue(5, 1);
    q.enqueue(1);
    q.enqueue(2);
    let drained = false;
    const draining = q.drain(1_000).then((left) => {
      drained = true;
      return left;
    });
    expect(q.enqueue(3)).toBe(false);
    expect(q.overflows).toEqual([1]);
    await q.started(1);
    q.finish(1);
    await q.started(2);
    expect(drained).toBe(false);
    q.finish(2);
    expect(await draining).toEqual({ abandoned: 0, running: 0 });
    expect(q.ran).toEqual([1, 2]);
  });

  test("an empty queue drains at once", async () => {
    const q = queue(5, 1);
    const started = Date.now();
    expect(await q.drain(60_000)).toEqual({ abandoned: 0, running: 0 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("the deadline holds: what has not started is abandoned and starts never", async () => {
    const q = queue(5, 1);
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);
    await q.started(1);
    const started = Date.now();
    expect(await q.drain(30)).toEqual({ abandoned: 2, running: 1 });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(25);
    expect(took).toBeLessThan(1_000);
    q.finish(1);
    await Bun.sleep(10);
    expect(q.ran).toEqual([1]);
  });

  test("a drain that finishes early leaves no timer holding the process", async () => {
    const q = queue(5, 1);
    q.enqueue(1);
    await q.started(1);
    const draining = q.drain(3_600_000);
    q.finish(1);
    expect(await draining).toEqual({ abandoned: 0, running: 0 });
  });
});
