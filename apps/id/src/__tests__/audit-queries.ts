import type { Database } from "../db/client.ts";
import * as queries from "../db/queries/audit.ts";
import { inPlatformRead } from "./platform-context.ts";
export { recordAuditEvent } from "../db/queries/audit.ts";
export type * from "../db/queries/audit.ts";

/** Existing data tests use the real platform reader boundary. */
export const listAuditEvents = (
  db: Database,
  filters: queries.AuditEventFilters,
  page: { cursor?: string; limit: number },
) =>
  inPlatformRead(db, (context) =>
    queries.listAuditEvents(context, filters, page),
  );

export const listUserAuditEvents = (
  db: Database,
  userId: string,
  filters: Parameters<typeof queries.listUserAuditEvents>[2],
  page: { cursor?: string; limit: number },
) =>
  inPlatformRead(db, (context) =>
    queries.listUserAuditEvents(context, userId, filters, page),
  );
