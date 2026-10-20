import { findInvalidTrustedProxies } from "@better-auth/core/utils/ip";
import { z } from "zod";
import type { PlatformApplications } from "./auth/platform-applications.ts";

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
        version: z.number().int().min(0),
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

/** The largest value a Postgres integer setting accepts. */
const maxInt32 = 2_147_483_647;

// Fixed settings. Every deployment ran the same values, and a change ships as a
// release either way, so they are constants rather than variables.
/** Twice a minute: often enough to see pool waits and 503s in the logs, rarely enough not to flood them. */
const OPERATIONAL_LOG_INTERVAL_MS = 30_000;
/** Expired rows are refused already; a minute keeps the tables small at one sweep per replica. */
const PROTOCOL_SWEEP_INTERVAL_MS = 60_000;
/** Rows per delete transaction: short row locks, far inside the statement timeout. */
const PROTOCOL_SWEEP_BATCH = 1_000;
/** Hands idle connections back to the database soon after a burst. */
const DATABASE_POOL_IDLE_TIMEOUT_MS = 10_000;
/** A request that cannot get a pooled connection in this time fails instead of queueing. */
const DATABASE_CONNECTION_TIMEOUT_MS = 5_000;
/** No request needs a longer statement; a runaway one is cancelled. */
const DATABASE_STATEMENT_TIMEOUT_MS = 10_000;
/** A command waiting on a row lock fails fast instead of holding its connection. */
const DATABASE_LOCK_TIMEOUT_MS = 2_000;
/** Ends a transaction a failed handler left open, and releases its locks. */
const DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;
/** The slug the first start seeds; the persisted binding is the authority afterwards. */
const PLATFORM_ORGANIZATION_SLUG = "answerable";
/** The platform organisation's display name at the first start; operators own it afterwards. */
const PLATFORM_ORGANIZATION_NAME = "Answerable";

const optionalCredential = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(47_300),
    DATABASE_URL: z.url(),
    /** The issuer, the pages' origin and the admin audience's base: one spelling, without a trailing slash. */
    BETTER_AUTH_URL: z.url().transform((url) => url.replace(/\/+$/, "")),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_SECRETS: applicationSecrets.optional(),
    GOOGLE_CLIENT_ID: optionalCredential,
    GOOGLE_CLIENT_SECRET: optionalCredential,
    MICROSOFT_CLIENT_ID: optionalCredential,
    MICROSOFT_CLIENT_SECRET: optionalCredential,
    BETTER_AUTH_TRUSTED_ORIGINS: z.string().default(""),
    /** Break-glass principal satisfying every platform scope; stops working once a human holds platform:write unless break-glass is set. */
    ROOT_ADMIN_SECRET: z.string().min(32).optional(),
    /** Override the human platform administrator lockout for break-glass use. */
    ROOT_ADMIN_BREAK_GLASS: z.enum(["true", "false"]).default("false"),
    TRUSTED_PROXY_CIDRS: z
      .string()
      .transform((value) => value.split(",").map((entry) => entry.trim()))
      .refine(
        (entries) => findInvalidTrustedProxies(entries).length === 0,
        "Expected valid proxy IP addresses or CIDRs",
      )
      .optional(),
    /** Connections per process; size it with docs/06's formula against the database's limit. */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(maxInt32).default(20),
  })
  .refine(
    (environment) =>
      environment.ROOT_ADMIN_BREAK_GLASS !== "true" ||
      environment.ROOT_ADMIN_SECRET !== undefined,
    { message: "ROOT_ADMIN_BREAK_GLASS requires ROOT_ADMIN_SECRET" },
  )
  .superRefine((environment, context) => {
    for (const [id, secret] of [
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    ] as const) {
      for (const [missing, other] of [
        [id, secret],
        [secret, id],
      ] as const) {
        if (
          environment[missing] === undefined &&
          environment[other] !== undefined
        )
          context.addIssue({
            code: "custom",
            path: [missing],
            message: `Required together with ${other}`,
          });
      }
    }
    if (environment.NODE_ENV !== "production") return;
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
    platformApplications: {
      ...(environment.GOOGLE_CLIENT_ID
        ? {
            google: {
              clientId: environment.GOOGLE_CLIENT_ID,
              clientSecret: environment.GOOGLE_CLIENT_SECRET!,
            },
          }
        : {}),
      ...(environment.MICROSOFT_CLIENT_ID
        ? {
            microsoft: {
              clientId: environment.MICROSOFT_CLIENT_ID,
              clientSecret: environment.MICROSOFT_CLIENT_SECRET!,
            },
          }
        : {}),
    } as PlatformApplications,
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT,
    databaseUrl: environment.DATABASE_URL,
    betterAuthUrl: environment.BETTER_AUTH_URL,
    betterAuthSecret: environment.BETTER_AUTH_SECRET,
    betterAuthSecrets: environment.BETTER_AUTH_SECRETS,
    trustedOrigins: environment.BETTER_AUTH_TRUSTED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    platformOrganizationSlug: PLATFORM_ORGANIZATION_SLUG,
    platformOrganizationName: PLATFORM_ORGANIZATION_NAME,
    /** The RFC 8707 resource indicator (aud) of the admin API itself. */
    adminResourceIdentifier: `${environment.BETTER_AUTH_URL}/api/admin`,
    rootAdminSecret: environment.ROOT_ADMIN_SECRET,
    rootAdminBreakGlass: environment.ROOT_ADMIN_BREAK_GLASS === "true",
    trustedProxyCidrs: environment.TRUSTED_PROXY_CIDRS ?? [],
    operationalLogIntervalMs: OPERATIONAL_LOG_INTERVAL_MS,
    protocolSweepIntervalMs: PROTOCOL_SWEEP_INTERVAL_MS,
    protocolSweepBatchSize: PROTOCOL_SWEEP_BATCH,
    databasePoolMax: environment.DATABASE_POOL_MAX,
    databasePoolIdleTimeoutMs: DATABASE_POOL_IDLE_TIMEOUT_MS,
    databaseConnectionTimeoutMs: DATABASE_CONNECTION_TIMEOUT_MS,
    databaseStatementTimeoutMs: DATABASE_STATEMENT_TIMEOUT_MS,
    databaseLockTimeoutMs: DATABASE_LOCK_TIMEOUT_MS,
    databaseIdleInTransactionTimeoutMs: DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    /** Outside production only: production's contract is the committed snapshots, not a live route. */
    openApiEnabled: environment.NODE_ENV !== "production",
  }));

/** Every variable the service reads; default.env at the repository root lists each one. */
export const environmentVariableNames = Object.keys(environmentSchema.in.shape);

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
