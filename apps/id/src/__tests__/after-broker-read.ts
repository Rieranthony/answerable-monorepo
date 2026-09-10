import type { Database } from "../db/client.ts";

/** Human principal resolution now owns a policy-read transaction before the service runs. */
export function afterBrokerRead(
  original: Database["transaction"],
  intercept: Database["transaction"],
): Database["transaction"] {
  let pending = true;
  return ((...args: Parameters<typeof original>) => {
    if (pending) {
      pending = false;
      return original(...args);
    }
    return intercept(...args);
  }) as typeof original;
}
