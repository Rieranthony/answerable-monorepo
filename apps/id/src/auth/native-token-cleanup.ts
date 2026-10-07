import type { NativeAdapter } from "./native-client-authentication.ts";
import { temporarilyUnavailable } from "./grant-error.ts";

/** Run inside the grant transaction: native cleanup may catch adapter errors. */
export async function withNativeTokenCleanup<T>(
  adapter: Pick<NativeAdapter, "deleteMany">,
  run: (deleteMany: NativeAdapter["deleteMany"]) => Promise<T>,
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
    throw temporarilyUnavailable(
      "Token revocation failed. Retry the token request.",
    );
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
