import type { Executor } from "../db/client.ts";
import { setDatabaseScope } from "../db/isolation.ts";
import { organizationCapabilities } from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";

/** Explicit fixture approval, separate from registration and token requests. */
export function approveMachineCapability(
  db: Executor,
  input: {
    organizationId: string;
    clientId: string;
    resource: string;
    scopes: string[];
  },
) {
  return db.transaction(async (tx) => {
    await setDatabaseScope(tx, { kind: "platform", access: "write" });
    const [row] = await tx
      .insert(organizationCapabilities)
      .values({ ...input, id: createId(), grantKind: "client_credentials" })
      .returning();
    return row!;
  });
}

/** Explicit tenant administration approval, independent of membership/assignment setup. */
export function approveAdminCapability(
  db: Executor,
  input: { organizationId: string; resource: string; scopes: string[] },
) {
  return db.transaction(async (tx) => {
    await setDatabaseScope(tx, { kind: "platform", access: "write" });
    const [row] = await tx
      .insert(organizationCapabilities)
      .values({ ...input, id: createId(), grantKind: "admin_session" })
      .returning();
    return row!;
  });
}
