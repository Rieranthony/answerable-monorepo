import { afterEach, describe, expect, test } from "bun:test";

import {
  EnvironmentValidationError,
  loadEnvironment,
  parseEnvironment,
} from "./env.ts";

const requiredEnvironment = {
  DATABASE_URL: "postgres://answerable:answerable@localhost:47432/answerable_id",
  BETTER_AUTH_URL: "http://localhost:47300",
  BETTER_AUTH_SECRET: "a-secret-that-is-definitely-32-characters",
};

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
});

describe("unit: environment", () => {
  test("parses defaults", () => {
    expect(parseEnvironment(requiredEnvironment)).toEqual({
      nodeEnv: "development",
      port: 47_300,
      databaseUrl: requiredEnvironment.DATABASE_URL,
      betterAuthUrl: requiredEnvironment.BETTER_AUTH_URL,
      betterAuthSecret: requiredEnvironment.BETTER_AUTH_SECRET,
      databasePoolMax: 5,
      databasePoolIdleTimeoutMs: 10_000,
      databaseConnectionTimeoutMs: 5_000,
      openApiEnabled: true,
    });
  });

  test("uses one test connection unless explicitly overridden", () => {
    expect(
      parseEnvironment({ ...requiredEnvironment, NODE_ENV: "test" })
        .databasePoolMax,
    ).toBe(1);
    expect(
      parseEnvironment({
        ...requiredEnvironment,
        NODE_ENV: "test",
        DATABASE_POOL_MAX: "3",
      }).databasePoolMax,
    ).toBe(3);
  });

  test("parses explicit runtime options", () => {
    const environment = parseEnvironment({
      ...requiredEnvironment,
      NODE_ENV: "production",
      PORT: "8080",
      DATABASE_POOL_MAX: "7",
      DATABASE_POOL_IDLE_TIMEOUT_MS: "2000",
      DATABASE_CONNECTION_TIMEOUT_MS: "3000",
      OPENAPI_ENABLED: "false",
    });

    expect(environment).toMatchObject({
      nodeEnv: "production",
      port: 8080,
      databasePoolMax: 7,
      databasePoolIdleTimeoutMs: 2_000,
      databaseConnectionTimeoutMs: 3_000,
      openApiEnabled: false,
    });
  });

  test("rejects invalid configuration", () => {
    expect(() =>
      parseEnvironment({ ...requiredEnvironment, BETTER_AUTH_SECRET: "short" }),
    ).toThrow(EnvironmentValidationError);
  });

  test("names every missing required variable", () => {
    expect(() => parseEnvironment({})).toThrow(
      /DATABASE_URL.*BETTER_AUTH_URL.*BETTER_AUTH_SECRET/,
    );
  });

  test("loads configuration from the process environment", () => {
    Object.assign(process.env, requiredEnvironment, { NODE_ENV: "test" });
    expect(loadEnvironment().databaseUrl).toBe(requiredEnvironment.DATABASE_URL);
  });
});
