import type { PlatformApplications } from "./auth/platform-applications.ts";
import { idConfig } from "./config.ts";

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

function toEnvironment(environment: ReturnType<typeof idConfig.read>) {
  return {
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
  };
}

export type Environment = ReturnType<typeof toEnvironment>;

/** Read ID's configuration from `source`; throws a `ConfigError` naming every variable it refuses. */
export function parseEnvironment(
  source: Record<string, string | undefined>,
): Environment {
  return toEnvironment(idConfig.read(source));
}

export function loadEnvironment(): Environment {
  return parseEnvironment(Bun.env);
}
