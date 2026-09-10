import * as queries from "../db/queries/sso-providers.ts";
export type * from "../db/queries/sso-providers.ts";
export {
  redactSsoProvider,
  serializeSsoProviderConfig,
} from "../db/queries/sso-providers.ts";
import type { Database } from "../db/client.ts";
import { inPlatformWrite } from "./platform-context.ts";
type Tail<T extends unknown[]> = T extends [unknown, ...infer A] ? A : never;
export const createSsoProvider = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.createSsoProvider>>
) =>
  inPlatformWrite(db, (context) => queries.createSsoProvider(context, ...args));
export const updateSsoProvider = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.updateSsoProvider>>
) =>
  inPlatformWrite(db, (context) => queries.updateSsoProvider(context, ...args));
export const deleteSsoProvider = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.deleteSsoProvider>>
) =>
  inPlatformWrite(db, (context) => queries.deleteSsoProvider(context, ...args));
export const findSsoProviderByOrganization = (
  db: Database,
  organizationId: string,
) =>
  inPlatformWrite(db, (context) =>
    queries.findSsoProviderForCommand(context, organizationId),
  );
