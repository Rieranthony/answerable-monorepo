import { afterAll, expect, spyOn, test } from "bun:test";
import { createAuth } from "../auth.ts";
import { APIError } from "better-auth/api";
import { createDatabase } from "../db/client.ts";
import { testEnvironment } from "../__tests__/support.ts";

const environment = testEnvironment();
const connection = createDatabase(environment);
afterAll(() => connection.close());

test("native error boundary sanitises unexpected errors and preserves protocol failures", () => {
  const auth = createAuth(connection.db, environment);
  const log = spyOn(console, "error").mockImplementation(() => {});
  const secret = "fixture-private-database-parameters";
  try {
    for (const status of ["FORBIDDEN", "SERVICE_UNAVAILABLE"] as const)
      expect(
        auth.options.onAPIError.onError(
          new APIError(status, { error: "expected_protocol_error" }),
        ),
      ).toBeUndefined();
    expect(log.mock.calls).toHaveLength(0);
    expect(() =>
      auth.options.onAPIError.onError(
        new Error(secret, { cause: { token: secret } }),
      ),
    ).toThrow("Authentication is temporarily unavailable");
    expect(log.mock.calls).toEqual([
      [
        "[id] auth",
        JSON.stringify({ level: "error", event: "provider_diagnostic" }),
      ],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  } finally {
    log.mockRestore();
  }
});

test("provider diagnostics retain severity without inspecting messages, errors or arguments", async () => {
  const auth = createAuth(connection.db, environment);
  const { logger } = await auth.$context;
  const log = spyOn(console, "error").mockImplementation(() => {});
  const secret = "fixture-token-password-upstream-body";
  const unsafe = {
    get token() {
      throw new Error("must not inspect payload");
    },
  };
  try {
    logger.debug(secret, unsafe);
    logger.info(secret, unsafe);
    logger.success(secret, unsafe);
    logger.warn(secret, new Error(secret), unsafe);
    logger.error(secret, new Error(secret, { cause: unsafe }), unsafe);
    expect(log.mock.calls).toEqual([
      [
        "[id] auth",
        JSON.stringify({ level: "warn", event: "provider_diagnostic" }),
      ],
      [
        "[id] auth",
        JSON.stringify({ level: "error", event: "provider_diagnostic" }),
      ],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  } finally {
    log.mockRestore();
  }
});
