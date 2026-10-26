import { afterEach, describe, expect, test } from "bun:test";

import { ConfigError } from "@answerable/config";
import { idConfig } from "./config.ts";
import { loadEnvironment, parseEnvironment } from "./env.ts";

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

const production = {
  ...requiredEnvironment,
  NODE_ENV: "production",
  BETTER_AUTH_TRUSTED_ORIGINS: "https://auth.example.com",
  TRUSTED_PROXY_CIDRS: "10.0.0.0/8, 2001:db8::/32",
};

describe("unit: environment", () => {
  test("reads exactly the variables ID documents", () => {
    expect(idConfig.fields.map((field) => field.name)).toEqual([
      "NODE_ENV",
      "PORT",
      "ID_HOST",
      "DATABASE_URL",
      "BETTER_AUTH_URL",
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_SECRETS",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "MICROSOFT_CLIENT_ID",
      "MICROSOFT_CLIENT_SECRET",
      "BETTER_AUTH_TRUSTED_ORIGINS",
      "ROOT_ADMIN_SECRET",
      "ROOT_ADMIN_BREAK_GLASS",
      "TRUSTED_PROXY_CIDRS",
      "DATABASE_POOL_MAX",
    ]);
  });

  test("parses production's defaults", () => {
    expect(parseEnvironment(production)).toEqual({
      nodeEnv: "production",
      port: 47_300,
      hostname: "127.0.0.1",
      databaseUrl: requiredEnvironment.DATABASE_URL,
      betterAuthUrl: requiredEnvironment.BETTER_AUTH_URL,
      betterAuthSecret: requiredEnvironment.BETTER_AUTH_SECRET,
      betterAuthSecrets: undefined,
      trustedOrigins: ["https://auth.example.com"],
      platformApplications: {},
      trustedProxyCidrs: ["10.0.0.0/8", "2001:db8::/32"],
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
      openApiEnabled: false,
      platformOrganizationSlug: "answerable",
      platformOrganizationName: "Answerable",
      adminResourceIdentifier: "http://localhost:47300/api/admin",
    });
  });

  test("development and test start with nothing set, on the local database, origin and fixed development secrets", () => {
    for (const NODE_ENV of [undefined, "development", "test"])
      expect(parseEnvironment({ NODE_ENV })).toMatchObject({
        nodeEnv: NODE_ENV ?? "development",
        port: 47_300,
        databaseUrl:
          "postgres://answerable_id_runtime:answerable@localhost:47432/answerable_id",
        betterAuthUrl: "http://localhost:47300",
        betterAuthSecret:
          "development-only-better-auth-secret-never-for-production",
        rootAdminSecret:
          "development-only-root-admin-secret-never-for-production",
        trustedOrigins: [],
        trustedProxyCidrs: [],
        openApiEnabled: true,
      });
  });

  test("listens on loopback unless ID_HOST names another address, as the image does", () => {
    expect(parseEnvironment({}).hostname).toBe("127.0.0.1");
    for (const ID_HOST of ["0.0.0.0", "::", "::1"])
      expect(parseEnvironment({ ID_HOST }).hostname).toBe(ID_HOST);
    expect(() => parseEnvironment({ ID_HOST: "id.example" })).toThrow(
      "Invalid ID configuration: ID_HOST: ",
    );
  });

  test("normalises the ID URL and derives the admin resource from it", () => {
    // The issuer, the pages and the admin audience must spell the origin alike.
    for (const suffix of ["", "/", "///"])
      expect(
        parseEnvironment({
          ...requiredEnvironment,
          BETTER_AUTH_URL: `https://id.example.com${suffix}`,
        }),
      ).toMatchObject({
        betterAuthUrl: "https://id.example.com",
        adminResourceIdentifier: "https://id.example.com/api/admin",
      });
  });

  test("production names every missing required variable", () => {
    expect(() => parseEnvironment({ NODE_ENV: "production" })).toThrow(
      /^Invalid ID configuration: DATABASE_URL: .*; BETTER_AUTH_URL: .*; BETTER_AUTH_SECRET: /,
    );
  });

  test("production refuses a development default pasted as a secret", () => {
    for (const [name, value] of [
      [
        "DATABASE_URL",
        "postgres://answerable_id_runtime:answerable@localhost:47432/answerable_id",
      ],
      [
        "BETTER_AUTH_SECRET",
        "development-only-better-auth-secret-never-for-production",
      ],
      [
        "ROOT_ADMIN_SECRET",
        "development-only-root-admin-secret-never-for-production",
      ],
    ] as const)
      expect(() => parseEnvironment({ ...production, [name]: value })).toThrow(
        `Invalid ID configuration: ${name}: a development default`,
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
  ).toThrow(ConfigError);
  expect(() =>
    parseEnvironment({
      ...production,
      ROOT_ADMIN_BREAK_GLASS: "true",
    }),
  ).toThrow("ROOT_ADMIN_BREAK_GLASS: Requires ROOT_ADMIN_SECRET");
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
  // An empty or blank ring is unset: ID signs with BETTER_AUTH_SECRET alone.
  for (const value of ["", " "])
    expect(
      parseEnvironment({ ...requiredEnvironment, BETTER_AUTH_SECRETS: value })
        .betterAuthSecrets,
    ).toBeUndefined();
  for (const value of [
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

test("production requires an explicit, valid ID origin; development and test default to the local one", () => {
  expect(
    parseEnvironment({
      ...production,
      BETTER_AUTH_URL: "https://id.example.com",
    }).betterAuthUrl,
  ).toBe("https://id.example.com");
  // No default: a staging pod with the variable unset must not name production's issuer.
  for (const value of [undefined, "", "   ", "invalid"])
    expect(() =>
      parseEnvironment({ ...production, BETTER_AUTH_URL: value }),
    ).toThrow("BETTER_AUTH_URL");
  for (const nodeEnv of [undefined, "development", "test"]) {
    for (const value of [undefined, ""])
      expect(
        parseEnvironment({
          ...requiredEnvironment,
          NODE_ENV: nodeEnv,
          BETTER_AUTH_URL: value,
        }).betterAuthUrl,
      ).toBe("http://localhost:47300");
    expect(() =>
      parseEnvironment({
        ...requiredEnvironment,
        NODE_ENV: nodeEnv,
        BETTER_AUTH_URL: "invalid",
      }),
    ).toThrow("BETTER_AUTH_URL");
  }
});

test("production serves no OpenAPI routes", () => {
  expect(parseEnvironment(production).openApiEnabled).toBe(false);
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
