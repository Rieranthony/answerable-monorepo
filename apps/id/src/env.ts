import { z } from "zod";

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(47_300),
    DATABASE_URL: z.url(),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).optional(),
    DATABASE_POOL_IDLE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .default(10_000),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .default(5_000),
    OPENAPI_ENABLED: z.enum(["true", "false"]).default("true"),
  })
  .transform((environment) => ({
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT,
    databaseUrl: environment.DATABASE_URL,
    betterAuthUrl: environment.BETTER_AUTH_URL,
    betterAuthSecret: environment.BETTER_AUTH_SECRET,
    databasePoolMax:
      environment.DATABASE_POOL_MAX ??
      (environment.NODE_ENV === "test" ? 1 : 5),
    databasePoolIdleTimeoutMs: environment.DATABASE_POOL_IDLE_TIMEOUT_MS,
    databaseConnectionTimeoutMs: environment.DATABASE_CONNECTION_TIMEOUT_MS,
    openApiEnabled: environment.OPENAPI_ENABLED === "true",
  }));

export type Environment = z.output<typeof environmentSchema>;

export class EnvironmentValidationError extends Error {
  constructor(error: z.ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
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
