import type { getOAuthProviderApi } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";

type Adapter = Parameters<typeof getOAuthProviderApi>[0]["context"]["adapter"];

/** Run inside the grant transaction: native cleanup may catch adapter errors. */
export async function withNativeTokenCleanup<T>(
  adapter: Pick<Adapter, "deleteMany">,
  run: (deleteMany: Adapter["deleteMany"]) => Promise<T>,
): Promise<T> {
  let failed = false;
  const outcome = await run(async (input) => {
    try {
      return await adapter.deleteMany(input);
    } catch (error) {
      failed = true;
      throw error;
    }
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  if (failed)
    throw new APIError(
      "SERVICE_UNAVAILABLE",
      {
        error: "temporarily_unavailable",
        error_description: "Token revocation failed. Retry the token request.",
      },
      { "Retry-After": "1" },
    );
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
