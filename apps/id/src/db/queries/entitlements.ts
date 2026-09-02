import { createId } from "../../lib/id.ts";
import type { Database } from "../client.ts";
import { entitlements } from "../schema/index.ts";

export type CreateEntitlementInput = {
  organizationId: string;
  /** Principal: omit both for an organization-wide grant. */
  memberId?: string;
  groupId?: string;
  /** Target: exactly one of an OAuth client id or an RFC 8707 resource. */
  clientId?: string;
  resource?: string;
  scopes: string[];
};

export async function createEntitlement(
  db: Database,
  input: CreateEntitlementInput,
) {
  const [entitlement] = await db
    .insert(entitlements)
    .values({ id: createId(), ...input })
    .returning();

  return entitlement!;
}
