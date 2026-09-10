import type { Context } from "hono";
import type { AppEnvironment } from "../context.ts";
import {
  withPlatformRead,
  type PlatformReadContext,
} from "../../services/platform-context.ts";
export function platformRead<T>(
  context: Context<AppEnvironment>,
  run: (platform: PlatformReadContext) => Promise<T>,
) {
  context.header("Cache-Control", "no-store");
  return withPlatformRead(
    context.get("db"),
    {
      principal: context.get("principal")!,
      environment: context.get("environment"),
      claims: context.get("bearerClaims"),
    },
    run,
  );
}
