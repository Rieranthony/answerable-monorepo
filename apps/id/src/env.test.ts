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
  test("parses dedicated upstream versions and rejects invalid rings without revealing values", () => {
    const keys = [
      { version: 2, value: Buffer.alloc(32, 2).toString("base64url") },
      { version: 1, value: Buffer.alloc(32, 1).toString("base64url") },
    ];
    expect(
      parseEnvironment({
        ...requiredEnvironment,
        UPSTREAM_TOKEN_SECRETS: JSON.stringify(keys),
      }).upstreamTokenSecrets,
    ).toEqual(keys);
    for (const value of [
      "not-json",
      "[]",
      "null",
      JSON.stringify([keys[0], keys[0]]),
      JSON.stringify([{ ...keys[0], version: 0 }]),
      JSON.stringify([{ ...keys[0], value: "private-short-secret" }]),
      JSON.stringify([{ ...keys[0], value: "A".repeat(42) + "B" }]),
    ]) {
      expect(() =>
        parseEnvironment({
          ...requiredEnvironment,
          UPSTREAM_TOKEN_SECRETS: value,
        }),
      ).toThrow(
        "UPSTREAM_TOKEN_SECRETS: Expected distinct positive key versions",
      );
      try {
        parseEnvironment({
          ...requiredEnvironment,
          UPSTREAM_TOKEN_SECRETS: value,
        });
      } catch (error) {
        expect(String(error)).not.toContain(value);
      }
    }
  });
  test("parses defaults", () => {
    expect(parseEnvironment(requiredEnvironment)).toEqual({
      nodeEnv: "development",
      port: 47_300,
      databaseUrl: requiredEnvironment.DATABASE_URL,
      betterAuthUrl: requiredEnvironment.BETTER_AUTH_URL,
      betterAuthSecret: requiredEnvironment.BETTER_AUTH_SECRET,
      betterAuthSecrets: undefined,
      upstreamTokenSecrets: undefined,
      trustedOrigins: ["http://localhost:47100"],
      trustedProxyCidrs: [],
      authPagesUrl: "http://localhost:47100",
      oauthRefreshReuseIntervalSeconds: 0,
      maxConcurrentRequests: 64,
      operationalLogIntervalMs: 30_000,
      databasePoolMax: 20,
      databasePoolIdleTimeoutMs: 10_000,
      databaseConnectionTimeoutMs: 5_000,
      databaseStatementTimeoutMs: 10_000,
      databaseLockTimeoutMs: 2_000,
      databaseIdleInTransactionTimeoutMs: 15_000,
      operationReplay: undefined,
      rootAdminSecret: undefined,
      rootAdminBreakGlass: false,
      openApiEnabled: true,
      platformOrganizationSlug: "answerable",
      platformOrganizationName: "Answerable",
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

  test("bounds operational reporting and permits explicit disabling", () => {
    for (const value of ["0", "1000", "2147483647"]) {
      expect(
        parseEnvironment({
          ...requiredEnvironment,
          OPERATIONAL_LOG_INTERVAL_MS: value,
        }).operationalLogIntervalMs,
      ).toBe(Number(value));
    }
    for (const value of ["-1", "999", "1000.5", "2147483648"]) {
      expect(() =>
        parseEnvironment({
          ...requiredEnvironment,
          OPERATIONAL_LOG_INTERVAL_MS: value,
        }),
      ).toThrow(EnvironmentValidationError);
    }
  });

  test("parses explicit runtime options", () => {
    const environment = parseEnvironment({
      ...requiredEnvironment,
      NODE_ENV: "production",
      TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
      PORT: "8080",
      MAX_CONCURRENT_REQUESTS: "12",
      DATABASE_POOL_MAX: "7",
      DATABASE_LOCK_TIMEOUT_MS: "900",
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "12000",
      DATABASE_POOL_IDLE_TIMEOUT_MS: "2000",
      DATABASE_CONNECTION_TIMEOUT_MS: "3000",
      DATABASE_STATEMENT_TIMEOUT_MS: "8000",
      OPENAPI_ENABLED: "false",
      PLATFORM_ORGANIZATION_SLUG: "platform-org",
      PLATFORM_ORGANIZATION_NAME: " Custom platform ",
      ADMIN_RESOURCE_IDENTIFIER: "https://admin.example.com/api/admin/",
      BETTER_AUTH_TRUSTED_ORIGINS:
        "https://chat.example.com, https://admin.example.com",
      AUTH_PAGES_URL: "https://auth.example.com",
    });

    expect(environment).toMatchObject({
      nodeEnv: "production",
      port: 8080,
      maxConcurrentRequests: 12,
      databasePoolMax: 7,
      databasePoolIdleTimeoutMs: 2_000,
      databaseConnectionTimeoutMs: 3_000,
      databaseStatementTimeoutMs: 8_000,
      databaseLockTimeoutMs: 900,
      databaseIdleInTransactionTimeoutMs: 12_000,
      openApiEnabled: false,
      platformOrganizationSlug: "platform-org",
      platformOrganizationName: "Custom platform",
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

  test("rejects blank platform names", () => {
    for (const name of ["", "   "]) {
      expect(() =>
        parseEnvironment({
          ...requiredEnvironment,
          PLATFORM_ORGANIZATION_NAME: name,
        }),
      ).toThrow(EnvironmentValidationError);
    }
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

test("replay configuration validates dedicated versioned keys without exposing their values", () => {
  const config = {
    activeKeyId: "current",
    keys: { current: Buffer.alloc(32, 7).toString("base64url") },
  };
  expect(
    parseEnvironment({
      ...requiredEnvironment,
      OPERATION_REPLAY_CONFIG: JSON.stringify(config),
    }),
  ).toMatchObject({ operationReplay: config });
  for (const value of [
    "not-json-secret",
    JSON.stringify({ ...config, activeKeyId: "missing" }),
    JSON.stringify({
      activeKeyId: "current",
      keys: { current: "invalid-key-secret" },
    }),
  ]) {
    try {
      parseEnvironment({
        ...requiredEnvironment,
        OPERATION_REPLAY_CONFIG: value,
      });
      throw new Error("configuration was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as Error).message).not.toContain(value);
      expect((error as Error).message).not.toContain("invalid-key-secret");
      expect((error as Error).message).toContain("OPERATION_REPLAY_CONFIG");
    }
  }
});

test("application secret rotation validates every retained version without leaking values", () => {
  const old = "retained-secret-value-that-is-over-32-characters";
  const current = "current-secret-value-that-is-over-32-characters";
  expect(
    parseEnvironment({
      ...requiredEnvironment,
      BETTER_AUTH_SECRETS: `2:${current},1:${old}`,
    }),
  ).toMatchObject({
    betterAuthSecrets: [
      { version: 2, value: current },
      { version: 1, value: old },
    ],
  });
  for (const value of [
    "",
    `2x:${current}`,
    `-1:${current}`,
    `1.5:${current}`,
    `1:${current},1:${old}`,
    `2:${current},1:short`,
    `2:${current},`,
    `9007199254740992:${current}`,
  ]) {
    expect(() =>
      parseEnvironment({ ...requiredEnvironment, BETTER_AUTH_SECRETS: value }),
    ).toThrow(
      "BETTER_AUTH_SECRETS: Expected distinct non-negative integer versions and secrets of at least 32 characters",
    );
    try {
      parseEnvironment({ ...requiredEnvironment, BETTER_AUTH_SECRETS: value });
    } catch (error) {
      expect(String(error)).not.toContain(current);
      expect(String(error)).not.toContain(old);
    }
  }
});

test("statement deadline rejects disabled, fractional and out-of-range values", () => {
  for (const value of ["0", "-1", "1.5", "2147483648", "not-a-number"])
    expect(() =>
      parseEnvironment({
        ...requiredEnvironment,
        DATABASE_STATEMENT_TIMEOUT_MS: value,
      }),
    ).toThrow("DATABASE_STATEMENT_TIMEOUT_MS");
});

test("request admission rejects disabled, fractional and excessive limits", () => {
  for (const value of ["0", "-1", "1.5", "9007199254740992", "invalid"])
    expect(() =>
      parseEnvironment({
        ...requiredEnvironment,
        MAX_CONCURRENT_REQUESTS: value,
      }),
    ).toThrow("MAX_CONCURRENT_REQUESTS");
});

const production = {
  ...requiredEnvironment,
  NODE_ENV: "production",
  AUTH_PAGES_URL: "https://auth.example.com",
  BETTER_AUTH_TRUSTED_ORIGINS: "https://auth.example.com",
  TRUSTED_PROXY_CIDRS: "10.0.0.0/8, 2001:db8::/32",
};
test("production disables OpenAPI unless explicitly enabled", () => {
  expect(parseEnvironment(production).openApiEnabled).toBe(false);
  expect(
    parseEnvironment({ ...production, OPENAPI_ENABLED: "true" }).openApiEnabled,
  ).toBe(true);
});
for (const key of [
  "AUTH_PAGES_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "TRUSTED_PROXY_CIDRS",
])
  test(`production requires ${key}`, () => {
    expect(() => parseEnvironment({ ...production, [key]: undefined })).toThrow(
      key,
    );
  });
for (const origin of [
  "https://example.com/",
  "https://example.com/path",
  "invalid",
  "https://example.com?x=1",
  "https://example.com#x",
])
  test(`production rejects non-origin ${origin}`, () => {
    expect(() =>
      parseEnvironment({ ...production, BETTER_AUTH_TRUSTED_ORIGINS: origin }),
    ).toThrow("BETTER_AUTH_TRUSTED_ORIGINS");
  });
for (const cidr of ["", "garbage", "10.0.0.0/33", "::/129", "10.0.0.0/-1"])
  test(`rejects invalid proxy CIDR ${cidr}`, () => {
    expect(() =>
      parseEnvironment({ ...requiredEnvironment, TRUSTED_PROXY_CIDRS: cidr }),
    ).toThrow("TRUSTED_PROXY_CIDRS");
  });
test("parses IPv4 and IPv6 proxy networks", () => {
  expect(parseEnvironment(production).trustedProxyCidrs).toEqual([
    "10.0.0.0/8",
    "2001:db8::/32",
  ]);
});

for (const key of [
  "DATABASE_LOCK_TIMEOUT_MS",
  "DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS",
]) {
  test(`${key} rejects disabled, fractional and out-of-range deadlines`, () => {
    for (const value of ["0", "-1", "1.5", "2147483648", "invalid"])
      expect(() =>
        parseEnvironment({ ...requiredEnvironment, [key]: value }),
      ).toThrow(key);
  });
}
