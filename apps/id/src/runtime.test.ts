import { describe, expect, test } from "bun:test";

import { testEnvironment } from "./__tests__/support.ts";
import { startRuntime } from "./runtime.ts";

describe("unit: process runtime", () => {
  test("starts Bun with one database pool and shuts it down idempotently", async () => {
    const runtime = startRuntime(testEnvironment({ port: 0 }));

    const response = await fetch(new URL("/healthz", runtime.server.url));
    expect(response.status).toBe(200);
    expect(runtime.database.pool.options.max).toBe(1);

    await runtime.shutdown();
    await runtime.shutdown();
    expect(runtime.database.pool.ended).toBe(true);
  });
});
