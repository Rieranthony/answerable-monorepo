import * as queries from "../db/queries/audit.ts";
import { bindQuery } from "./bind-query.ts";
import { inPlatformRead } from "./platform-context.ts";
export type * from "../db/queries/audit.ts";
export { recordAuditEvent } from "../db/queries/audit.ts";

/** Existing data tests use the real platform reader boundary. */
export const listAuditEvents = bindQuery(inPlatformRead)(
  queries.listAuditEvents,
);

export const listUserAuditEvents = bindQuery(inPlatformRead)(
  queries.listUserAuditEvents,
);
