import { afterEach, describe, expect, test } from "bun:test";

import {
  EnvironmentValidationError,
  loadEnvironment,
  parseEnvironment,
  environmentVariableNames,
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
      trustedOrigins: [],
      platformApplications: {},
      trustedProxyCidrs: [],
      oauthRefreshReuseIntervalSeconds: 0,
      operationalLogIntervalMs: 30_000,
      databasePoolMax: 20,
      databasePoolIdleTimeoutMs: 10_000,
      databaseConnectionTimeoutMs: 5_000,
      databaseStatementTimeoutMs: 10_000,
      databaseLockTimeoutMs: 2_000,
      databaseIdleInTransactionTimeoutMs: 15_000,
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
    });

    expect(environment).toMatchObject({
      nodeEnv: "production",
      port: 8080,
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

const production = {
  ...requiredEnvironment,
  NODE_ENV: "production",
  BETTER_AUTH_TRUSTED_ORIGINS: "https://auth.example.com",
  TRUSTED_PROXY_CIDRS: "10.0.0.0/8, 2001:db8::/32",
};
test("production defaults the ID origin and admin audience when the URL is unset or blank", () => {
  for (const value of [undefined, "", "   "]) {
    const environment = parseEnvironment({
      ...production,
      BETTER_AUTH_URL: value,
    });
    expect(environment.betterAuthUrl).toBe("https://id.answerable.org");
    expect(environment.adminResourceIdentifier).toBe(
      "https://id.answerable.org/api/admin",
    );
  }
});

test("production preserves explicit ID origins and rejects invalid overrides", () => {
  expect(
    parseEnvironment({ ...production, BETTER_AUTH_URL: "https://id.example.com" })
      .betterAuthUrl,
  ).toBe("https://id.example.com");
  expect(() =>
    parseEnvironment({ ...production, BETTER_AUTH_URL: "invalid" }),
  ).toThrow("BETTER_AUTH_URL");
});

test("development and test still require an explicit ID origin", () => {
  for (const nodeEnv of [undefined, "development", "test"]) {
    expect(() =>
      parseEnvironment({
        ...requiredEnvironment,
        NODE_ENV: nodeEnv,
        BETTER_AUTH_URL: undefined,
      }),
    ).toThrow("BETTER_AUTH_URL");
  }
});

test("production disables OpenAPI unless explicitly enabled", () => {
  expect(parseEnvironment(production).openApiEnabled).toBe(false);
  expect(
    parseEnvironment({ ...production, OPENAPI_ENABLED: "true" }).openApiEnabled,
  ).toBe(true);
});
for (const key of ["BETTER_AUTH_TRUSTED_ORIGINS", "TRUSTED_PROXY_CIDRS"])
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

test("platform application pairs parse in every environment and blank values are unset", () => {
  for (const base of [
    requiredEnvironment,
    { ...requiredEnvironment, NODE_ENV: "test" },
    production,
  ]) {
    expect(
      parseEnvironment({
        ...base,
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "  ",
        MICROSOFT_CLIENT_ID: " ",
        MICROSOFT_CLIENT_SECRET: "",
      }).platformApplications,
    ).toEqual({});
    const parsed = parseEnvironment({
      ...base,
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-private",
      MICROSOFT_CLIENT_ID: "microsoft-id",
      MICROSOFT_CLIENT_SECRET: "microsoft-private",
    });
    expect(parsed.platformApplications.google?.clientId === "google-id").toBe(
      true,
    );
    expect(
      parsed.platformApplications.google?.clientSecret === "google-private",
    ).toBe(true);
    expect(
      parsed.platformApplications.microsoft?.clientId === "microsoft-id",
    ).toBe(true);
    expect(
      parsed.platformApplications.microsoft?.clientSecret ===
        "microsoft-private",
    ).toBe(true);
    for (const [id, secret] of [
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    ]) {
      for (const [present, missing] of [
        [id!, secret!],
        [secret!, id!],
      ]) {
        for (const blank of [undefined, "", "   "]) {
          const source = {
            ...base,
            [present!]: "never-echo-this-value",
            [missing!]: blank,
          };
          expect(() => parseEnvironment(source)).toThrow(
            `${missing}: Required together with ${present}`,
          );
          try {
            parseEnvironment(source);
          } catch (error) {
            expect(String(error).includes("never-echo-this-value")).toBe(false);
          }
        }
      }
    }
  }
});

test("default.env lists every variable with an empty value", async () => {
  const assignments = (
    await Bun.file(new URL("../../../default.env", import.meta.url)).text()
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const names = assignments.map((line) => line.split("=", 1)[0]!);
  expect(
    assignments
      .filter((line) => !/^[A-Z][A-Z0-9_]*=$/.test(line))
      .map((line) => line.split("=", 1)[0]),
    "default.env holds names with empty values only",
  ).toEqual([]);
  expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual(
    [],
  );
  // Read outside the service schema: migrations, the test database and the OpenAPI export.
  const tooling = [
    "DATABASE_MIGRATION_URL",
    "DATABASE_RUNTIME_ROLE",
    "PUBLIC_ID_URL",
    "TEST_DATABASE_URL",
  ];
  expect(
    [...environmentVariableNames, ...tooling].filter(
      (name) => !names.includes(name),
    ),
    "Add the missing variables to default.env",
  ).toEqual([]);
});

test("trusted origins trim whitespace and discard empty entries without a fallback", () => {
  for (const value of ["", " , , "]) {
    expect(
      parseEnvironment({
        ...requiredEnvironment,
        BETTER_AUTH_TRUSTED_ORIGINS: value,
      }).trustedOrigins,
    ).toEqual([]);
  }
  expect(
    parseEnvironment({
      ...requiredEnvironment,
      BETTER_AUTH_TRUSTED_ORIGINS:
        " , https://browser.example, , https://issuer.example , ",
    }).trustedOrigins,
  ).toEqual(["https://browser.example", "https://issuer.example"]);
});
