import { afterAll, expect, test } from "bun:test";
import type { BetterAuthOptions } from "better-auth";
import { createAuth } from "../auth.ts";
import { createDatabase } from "../db/client.ts";
import { testEnvironment } from "../__tests__/support.ts";
const environment = testEnvironment();
const connection = createDatabase(environment);
afterAll(() => connection.close());

test("native rate limiting remains enabled and forged forwarding headers cannot change its bucket", async () => {
  const auth = createAuth(connection.db, environment);
  const context = await auth.$context;
  context.rateLimit.enabled = true;
  context.rateLimit.max = 1;
  const keys: string[] = [];
  const counts = new Map<string, number>();
  // Isolated storage exercises the real native limiter without sharing other tests' counters.
  const options: BetterAuthOptions = context.options;
  options.rateLimit = {
    customStorage: {
      consume: async (key, rule) => {
        keys.push(key);
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return count <= rule.max
          ? { allowed: true, retryAfter: null }
          : { allowed: false, retryAfter: rule.window };
      },
    },
  };
  for (const [address, status] of [
    ["192.0.2.1", 200],
    ["198.51.100.7", 429],
  ] as const) {
    const response = await auth.handler(
      new Request(`${environment.betterAuthUrl}/auth/ok`, {
        headers: {
          "x-forwarded-for": address,
          "x-real-ip": address,
          "cf-connecting-ip": address,
        },
      }),
    );
    expect(response.status).toBe(status);
  }
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(keys.join()).not.toContain("192.0.2.1");
  expect(keys.join()).not.toContain("198.51.100.7");
});
