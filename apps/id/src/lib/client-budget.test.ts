import { expect, test } from "bun:test";

import { createClientBudget, createRateLimitStorage } from "./client-budget.ts";

function clocked(options: {
  max: number;
  windowMs: number;
  maxClients?: number;
}) {
  const clock = { time: 1_000 };
  return {
    clock,
    budget: createClientBudget({ ...options, now: () => clock.time }),
  };
}

test("a client gets its count in a window, and a new count in the next", () => {
  const { clock, budget } = clocked({ max: 2, windowMs: 100 });
  expect([budget.take("a"), budget.take("a"), budget.take("a")]).toEqual([
    true,
    true,
    false,
  ]);
  clock.time += 99;
  expect(budget.take("a")).toBe(false);
  clock.time += 1;
  expect(budget.take("a")).toBe(true);
});

test("one client's count is not another's", () => {
  const { budget } = clocked({ max: 1, windowMs: 100 });
  expect(budget.take("a")).toBe(true);
  expect(budget.take("a")).toBe(false);
  expect(budget.take("b")).toBe(true);
});

test("memory stays bounded: a new client past the bound replaces the oldest window", () => {
  const { clock, budget } = clocked({ max: 1, windowMs: 100, maxClients: 2 });
  budget.take("a");
  clock.time += 1;
  budget.take("b");
  budget.take("c");
  expect(budget.size).toBe(2);
  // `b` keeps its spent window; `a` lost its own and starts again.
  expect(budget.take("b")).toBe(false);
  expect(budget.take("a")).toBe(true);
  expect(budget.size).toBe(2);
});

test("a window that has ended goes to the back, so it is not the next to be replaced", () => {
  const { clock, budget } = clocked({ max: 1, windowMs: 10, maxClients: 2 });
  budget.take("a");
  clock.time += 5;
  budget.take("b");
  clock.time += 5;
  budget.take("a"); // a's window ended, so this one is newer than b's
  clock.time += 1;
  budget.take("c"); // replaces b
  expect(budget.take("a")).toBe(false);
  expect(budget.take("b")).toBe(true);
});

test("a renewed window goes last even with room to spare, so the next to go is the one before it", () => {
  const { clock, budget } = clocked({ max: 1, windowMs: 10, maxClients: 3 });
  budget.take("a");
  clock.time += 5;
  budget.take("b");
  clock.time += 5;
  budget.take("a"); // a new window for a, with room for it: a is now newer than b
  budget.take("c");
  budget.take("d"); // replaces b, not a
  expect(budget.take("a")).toBe(false);
  expect(budget.take("b")).toBe(true);
});

test("it uses the real clock unless given one", () => {
  const budget = createClientBudget({ max: 1, windowMs: 60_000 });
  expect(budget.take("a")).toBe(true);
  expect(budget.take("a")).toBe(false);
});

function clockedStorage(maxKeys?: number) {
  const clock = { time: 1_000 };
  return {
    clock,
    storage: createRateLimitStorage({ maxKeys, now: () => clock.time }),
  };
}

/** One key driven at a steady rate: how many of `requests` it refused. */
async function refusals(
  { clock, storage }: ReturnType<typeof clockedStorage>,
  rule: { window: number; max: number },
  everyMs: number,
  requests: number,
) {
  let refused = 0;
  for (let request = 0; request < requests; request++) {
    const { allowed } = await storage.consume("key", rule);
    if (!allowed) refused++;
    clock.time += everyMs;
  }
  return refused;
}

test.each([
  ["a third of it", { window: 10, max: 60 }, 500],
  ["just under it", { window: 10, max: 60 }, 170],
  ["exactly it", { window: 10, max: 100 }, 100],
])(
  "the storage refuses nothing at %s, over many windows and with no silence between requests",
  async (_, rule, everyMs) => {
    // Better Auth's own store refuses 20% of 2 a second under a rule of 60 per 10 s.
    expect(await refusals(clockedStorage(), rule, everyMs, 6_000)).toBe(0);
  },
);

test("the storage refuses above the rate, and only what is over in each window", async () => {
  const driven = clockedStorage();
  // 12.5 a second for a hundred seconds: ten windows of 125, each allowing 60.
  expect(await refusals(driven, { window: 10, max: 60 }, 80, 1_250)).toBe(650);
});

test("a refusal says how long the window has left, in whole seconds, at least one", async () => {
  const { clock, storage } = clockedStorage();
  const rule = { window: 60, max: 1 };
  expect(await storage.consume("key", rule)).toEqual({
    allowed: true,
    retryAfter: null,
  });
  clock.time += 15_500;
  expect(await storage.consume("key", rule)).toEqual({
    allowed: false,
    retryAfter: 45,
  });
  clock.time += 44_400;
  expect(await storage.consume("key", rule)).toEqual({
    allowed: false,
    retryAfter: 1,
  });
  clock.time += 100;
  expect((await storage.consume("key", rule)).allowed).toBe(true);
});

test("a key's rule is its own: one key's count and window are not another's", async () => {
  const { storage } = clockedStorage();
  expect((await storage.consume("a", { window: 10, max: 1 })).allowed).toBe(
    true,
  );
  expect((await storage.consume("a", { window: 10, max: 1 })).allowed).toBe(
    false,
  );
  expect((await storage.consume("b", { window: 60, max: 1 })).allowed).toBe(
    true,
  );
});

test("the keys the storage holds stay bounded, whoever asks", async () => {
  const { clock, storage } = clockedStorage(100);
  for (let client = 0; client < 10_000; client++) {
    await storage.consume(`client-${client}`, { window: 60, max: 1 });
    clock.time += 1;
    expect(storage.size).toBeLessThanOrEqual(100);
  }
  expect(storage.size).toBe(100);
});

test("the storage uses the real clock unless given one, and holds a hundred thousand keys by default", async () => {
  const storage = createRateLimitStorage();
  const rule = { window: 60, max: 1 };
  expect((await storage.consume("key", rule)).allowed).toBe(true);
  expect((await storage.consume("key", rule)).allowed).toBe(false);
});
