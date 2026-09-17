import type { Environment } from "../env.ts";

export function serviceUrl(environment: Environment): string {
  return environment.betterAuthUrl.replace(/\/+$/, "");
}
