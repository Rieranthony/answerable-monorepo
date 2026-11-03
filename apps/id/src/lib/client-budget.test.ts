import { expect, test } from "bun:test";

import { createClientBudget } from "./client-budget.ts";

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
