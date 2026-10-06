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
      protocolSweepIntervalMs: 60_000,
      protocolSweepBatchSize: 1_000,
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

  test("operational reporting is disabled by zero or runs at least once a second", () => {
    for (const value of ["0", "1000"]) {
      expect(
        parseEnvironment({
          ...requiredEnvironment,
          OPERATIONAL_LOG_INTERVAL_MS: value,
        }).operationalLogIntervalMs,
      ).toBe(Number(value));
    }
    expect(() =>
      parseEnvironment({
        ...requiredEnvironment,
        OPERATIONAL_LOG_INTERVAL_MS: "999",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  test("the protocol sweep is disabled by zero or runs at least once a second, in positive batches", () => {
    for (const value of ["0", "1000"]) {
      expect(
        parseEnvironment({
          ...requiredEnvironment,
          PROTOCOL_SWEEP_INTERVAL_MS: value,
        }).protocolSweepIntervalMs,
      ).toBe(Number(value));
    }
    expect(
      parseEnvironment({ ...requiredEnvironment, PROTOCOL_SWEEP_BATCH: "1" })
        .protocolSweepBatchSize,
    ).toBe(1);
    for (const [name, value] of [
      ["PROTOCOL_SWEEP_INTERVAL_MS", "999"],
      ["PROTOCOL_SWEEP_INTERVAL_MS", "-1"],
      ["PROTOCOL_SWEEP_BATCH", "0"],
      ["PROTOCOL_SWEEP_BATCH", "1.5"],
    ])
      expect(() =>
        parseEnvironment({ ...requiredEnvironment, [name]: value }),
      ).toThrow(EnvironmentValidationError);
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
    parseEnvironment({
      ...production,
      BETTER_AUTH_URL: "https://id.example.com",
    }).betterAuthUrl,
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
test("rejects an invalid proxy CIDR", () => {
  expect(() =>
    parseEnvironment({
      ...requiredEnvironment,
      TRUSTED_PROXY_CIDRS: "10.0.0.0/33",
    }),
  ).toThrow("TRUSTED_PROXY_CIDRS");
});
test("parses IPv4 and IPv6 proxy networks", () => {
  expect(parseEnvironment(production).trustedProxyCidrs).toEqual([
    "10.0.0.0/8",
    "2001:db8::/32",
  ]);
});

// The pair check runs before the production-only rules, so one environment proves it.
test("platform application pairs parse together and blank values are unset", () => {
  {
    const base = production;
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
