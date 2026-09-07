import { afterEach, describe, expect, test } from "bun:test";

import {
  EnvironmentValidationError,
  loadEnvironment,
  parseEnvironment,
} from "./env.ts";

const requiredEnvironment = {
  DATABASE_URL:
    "postgres://answerable:answerable@localhost:47432/answerable_id",
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
      trustedOrigins: ["http://localhost:47100"],
      authPagesUrl: "http://localhost:47100",
      databasePoolMax: 5,
      databasePoolIdleTimeoutMs: 10_000,
      databaseConnectionTimeoutMs: 5_000,
      rootAdminSecret: undefined,
      rootAdminBreakGlass: false,
      openApiEnabled: true,
      platformOrganizationSlug: "answerable",
      adminResourceIdentifier: "http://localhost:47300/api/admin",
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
      PLATFORM_ORGANIZATION_SLUG: "platform-org",
      ADMIN_RESOURCE_IDENTIFIER: "https://admin.example.com/api/admin/",
      BETTER_AUTH_TRUSTED_ORIGINS:
        "https://chat.example.com, https://admin.example.com",
      AUTH_PAGES_URL: "https://auth.example.com",
    });

    expect(environment).toMatchObject({
      nodeEnv: "production",
      port: 8080,
      databasePoolMax: 7,
      databasePoolIdleTimeoutMs: 2_000,
      databaseConnectionTimeoutMs: 3_000,
      openApiEnabled: false,
      platformOrganizationSlug: "platform-org",
      adminResourceIdentifier: "https://admin.example.com/api/admin",
      trustedOrigins: ["https://chat.example.com", "https://admin.example.com"],
      authPagesUrl: "https://auth.example.com",
    });
  });

  test("normalises the default resource URL and rejects invalid admin configuration", () => {
    expect(
      parseEnvironment({
        ...requiredEnvironment,
        BETTER_AUTH_URL: "https://id.example.com/",
      }).adminResourceIdentifier,
    ).toBe("https://id.example.com/api/admin");
    for (const slug of ["Bad", "-bad", "bad-", "bad--slug", "bad_slug", ""]) {
      expect(() =>
        parseEnvironment({
          ...requiredEnvironment,
          PLATFORM_ORGANIZATION_SLUG: slug,
        }),
      ).toThrow(EnvironmentValidationError);
    }
    expect(() =>
      parseEnvironment({
        ...requiredEnvironment,
        ADMIN_RESOURCE_IDENTIFIER: "bad",
      }),
    ).toThrow(EnvironmentValidationError);
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
    expect(loadEnvironment().databaseUrl).toBe(
      requiredEnvironment.DATABASE_URL,
    );
  });
});

test("validates root configuration", () => {
  expect(() =>
    parseEnvironment({
      ...requiredEnvironment,
      ROOT_ADMIN_SECRET: "x".repeat(31),
    }),
  ).toThrow(EnvironmentValidationError);
  expect(() =>
    parseEnvironment({
      ...requiredEnvironment,
      ROOT_ADMIN_BREAK_GLASS: "true",
    }),
  ).toThrow("ROOT_ADMIN_BREAK_GLASS requires ROOT_ADMIN_SECRET");
  expect(
    parseEnvironment({
      ...requiredEnvironment,
      ROOT_ADMIN_SECRET: "x".repeat(32),
      ROOT_ADMIN_BREAK_GLASS: "true",
    }),
  ).toMatchObject({
    rootAdminSecret: "x".repeat(32),
    rootAdminBreakGlass: true,
  });
});
