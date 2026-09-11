import { findInvalidTrustedProxies } from "@better-auth/core/utils/ip";
import { z } from "zod";
import { createOperationCipher } from "./services/operation-cipher.ts";
import { upstreamTokenSecretsSchema } from "./auth/upstream-token-storage.ts";

const applicationSecrets = z.string().transform((value, context) => {
  const entries = value.split(",").map((entry) => {
    const match = /^([0-9]+):(.+)$/.exec(entry.trim());
    return {
      version: match ? Number(match[1]) : NaN,
      value: match?.[2]?.trim() ?? "",
    };
  });
  const parsed = z
    .array(
      z.object({
        version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        value: z.string().min(32),
      }),
    )
    .min(1)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.version)).size === entries.length,
    )
    .safeParse(entries);
  if (parsed.success) return parsed.data;
  context.addIssue({
    code: "custom",
    message:
      "Expected distinct non-negative integer versions and secrets of at least 32 characters",
  });
  return z.NEVER;
});

const upstreamTokenSecrets = z.string().transform((value, context) => {
  try {
    return upstreamTokenSecretsSchema.parse(JSON.parse(value));
  } catch {
    context.addIssue({
      code: "custom",
      message:
        "Expected distinct positive key versions and canonical 256-bit base64url upstream keys",
    });
    return z.NEVER;
  }
});

const replayConfig = z.string().transform((value, context) => {
  try {
    const config = z
      .object({
        activeKeyId: z.string(),
        keys: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(value));
    createOperationCipher(config);
    return config;
  } catch {
    context.addIssue({
      code: "custom",
      message:
        "Expected a valid activeKeyId and canonical 256-bit base64url keys",
    });
    return z.NEVER;
  }
});

/** Browser origins Better Auth trusts; the pages origin when none is set. */
const parseTrustedOrigins = (value: string, fallback: string) => {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : [fallback];
};

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(47_300),
    DATABASE_URL: z.url(),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_SECRETS: applicationSecrets.optional(),
    UPSTREAM_TOKEN_SECRETS: upstreamTokenSecrets.optional(),
    OPERATION_REPLAY_CONFIG: replayConfig.optional(),
    BETTER_AUTH_TRUSTED_ORIGINS: z.string().default(""),
    /** Initial platform slug; persisted system bindings determine authority afterwards. */
    PLATFORM_ORGANIZATION_SLUG: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .default("answerable"),
    /** Display name of the platform organisation seeded at startup. */
    PLATFORM_ORGANIZATION_NAME: z.string().trim().min(1).default("Answerable"),
    /** The RFC 8707 resource indicator (aud) of the admin API itself. */
    ADMIN_RESOURCE_IDENTIFIER: z.url().optional(),
    /** Break-glass principal satisfying every platform scope; stops working once a human holds platform:write unless break-glass is set. */
    ROOT_ADMIN_SECRET: z.string().min(32).optional(),
    /** Override the human platform administrator lockout for break-glass use. */
    ROOT_ADMIN_BREAK_GLASS: z.enum(["true", "false"]).default("false"),
    AUTH_PAGES_URL: z.url().optional(),
    TRUSTED_PROXY_CIDRS: z
      .string()
      .transform((value) => value.split(",").map((entry) => entry.trim()))
      .refine(
        (entries) => findInvalidTrustedProxies(entries).length === 0,
        "Expected valid proxy IP addresses or CIDRs",
      )
      .optional(),
    OAUTH_REFRESH_REUSE_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).default(64),
    OPERATIONAL_LOG_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(2_147_483_647)
      .refine(
        (value) => value === 0 || value >= 1000,
        "Use zero to disable or at least 1000 milliseconds",
      )
      .default(30_000),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).optional(),
    DATABASE_POOL_IDLE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .default(10_000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .max(2_147_483_647)
      .default(10_000),
    DATABASE_LOCK_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .max(2_147_483_647)
      .default(2_000),
    DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .max(2_147_483_647)
      .default(15_000),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .default(5_000),
    OPENAPI_ENABLED: z.enum(["true", "false"]).optional(),
  })
  .refine(
    (environment) =>
      environment.ROOT_ADMIN_BREAK_GLASS !== "true" ||
      environment.ROOT_ADMIN_SECRET !== undefined,
    { message: "ROOT_ADMIN_BREAK_GLASS requires ROOT_ADMIN_SECRET" },
  )
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== "production") return;
    if (!environment.AUTH_PAGES_URL)
      context.addIssue({
        code: "custom",
        path: ["AUTH_PAGES_URL"],
        message: "Required in production",
      });
    if (!environment.TRUSTED_PROXY_CIDRS?.length)
      context.addIssue({
        code: "custom",
        path: ["TRUSTED_PROXY_CIDRS"],
        message: "Required in production",
      });
    const origins = environment.BETTER_AUTH_TRUSTED_ORIGINS.split(",").map(
      (origin) => origin.trim(),
    );
    if (
      origins.some((origin) => {
        try {
          return new URL(origin).origin !== origin || !/^https?:/.test(origin);
        } catch {
          return true;
        }
      })
    )
      context.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_TRUSTED_ORIGINS"],
        message: "Required origin-only HTTP(S) URLs in production",
      });
  })
  .transform((environment) => ({
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT,
    databaseUrl: environment.DATABASE_URL,
    betterAuthUrl: environment.BETTER_AUTH_URL,
    betterAuthSecret: environment.BETTER_AUTH_SECRET,
    betterAuthSecrets: environment.BETTER_AUTH_SECRETS,
    upstreamTokenSecrets: environment.UPSTREAM_TOKEN_SECRETS,
    operationReplay: environment.OPERATION_REPLAY_CONFIG,
    trustedOrigins: parseTrustedOrigins(
      environment.BETTER_AUTH_TRUSTED_ORIGINS,
      environment.AUTH_PAGES_URL ?? "http://localhost:47100",
    ),
    platformOrganizationSlug: environment.PLATFORM_ORGANIZATION_SLUG,
    platformOrganizationName: environment.PLATFORM_ORGANIZATION_NAME,
    adminResourceIdentifier: (
      environment.ADMIN_RESOURCE_IDENTIFIER ??
      `${environment.BETTER_AUTH_URL.replace(/\/+$/, "")}/api/admin`
    ).replace(/\/+$/, ""),
    rootAdminSecret: environment.ROOT_ADMIN_SECRET,
    rootAdminBreakGlass: environment.ROOT_ADMIN_BREAK_GLASS === "true",
    authPagesUrl: environment.AUTH_PAGES_URL ?? "http://localhost:47100",
    trustedProxyCidrs: environment.TRUSTED_PROXY_CIDRS ?? [],
    oauthRefreshReuseIntervalSeconds:
      environment.OAUTH_REFRESH_REUSE_INTERVAL_SECONDS,
    maxConcurrentRequests: environment.MAX_CONCURRENT_REQUESTS,
    operationalLogIntervalMs: environment.OPERATIONAL_LOG_INTERVAL_MS,
    databasePoolMax:
      environment.DATABASE_POOL_MAX ??
      (environment.NODE_ENV === "test" ? 1 : 20),
    databasePoolIdleTimeoutMs: environment.DATABASE_POOL_IDLE_TIMEOUT_MS,
    databaseConnectionTimeoutMs: environment.DATABASE_CONNECTION_TIMEOUT_MS,
    databaseStatementTimeoutMs: environment.DATABASE_STATEMENT_TIMEOUT_MS,
    databaseLockTimeoutMs: environment.DATABASE_LOCK_TIMEOUT_MS,
    databaseIdleInTransactionTimeoutMs:
      environment.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    openApiEnabled:
      environment.OPENAPI_ENABLED === undefined
        ? environment.NODE_ENV !== "production"
        : environment.OPENAPI_ENABLED === "true",
  }));

export type Environment = z.output<typeof environmentSchema>;

export class EnvironmentValidationError extends Error {
  constructor(error: z.ZodError) {
    const details = error.issues
      .map(
        (issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`,
      )
      .join("; ");

    super(`Invalid environment variables: ${details}`);
    this.name = "EnvironmentValidationError";
  }
}

export function parseEnvironment(
  source: Record<string, string | undefined>,
): Environment {
  const result = environmentSchema.safeParse(source);

  if (!result.success) throw new EnvironmentValidationError(result.error);

  return result.data;
}

export function loadEnvironment(): Environment {
  return parseEnvironment(Bun.env);
}
