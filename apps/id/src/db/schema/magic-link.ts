import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations } from "./auth.ts";
import { id, timestampColumn, vocabularyCheck } from "./columns.ts";
import { protocolRecordPolicies } from "./tenant-policies.ts";
import { magicLinkPurposes, magicLinkSendStatuses } from "./vocabulary.ts";

/**
 * One sign-in email ID tried to send: a stranger writes no row. Better Auth's `verifications`
 * holds the token's hash, and this row what binds it to a browser and a code. The sweep
 * removes a row seven days after it was made; until then diagnosis can read it, so staff can
 * see a suppressed address.
 */
export const magicLinkRequests = pgTable(
  "magic_link_requests",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The magic-link row and its revision at issue. No key, as a session's origin has
     * none: an insert here must take no lock on a row that commands update. */
    providerId: uuid("provider_id").notNull(),
    providerRevision: integer("provider_revision").notNull(),
    purpose: text("purpose", { enum: magicLinkPurposes }).notNull(),
    email: text("email").notNull(),
    /** `magic-link:<hash>`, the identifier of this request's row in `verifications`. */
    tokenIdentifier: text("token_identifier").unique(),
    /** The hash of the browser's sign-in cookie, the only way to the code. */
    browserHash: text("browser_hash"),
    /** An HMAC of the client address: what the per-client limits key on. */
    clientHash: text("client_hash").notNull(),
    /** An HMAC of the code under a key the database does not hold, bound to this row's id,
     * since eight digits reverse at once from a plain hash. */
    codeHmac: text("code_hmac"),
    attempts: integer("attempts").default(0).notNull(),
    /** The signed query of the authorisation this sign-in resumes. */
    pendingOauthQuery: text("pending_oauth_query"),
    expiresAt: timestampColumn("expires_at").notNull(),
    sendStatus: text("send_status", { enum: magicLinkSendStatuses })
      .default("sending")
      .notNull(),
    /** Postmark's answer to a failed send: 406 is a suppressed address. */
    postmarkErrorCode: integer("postmark_error_code"),
    postmarkHttpStatus: integer("postmark_http_status"),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
  },
  (table) => [
    ...protocolRecordPolicies(table.organizationId),
    check(
      "magic_link_requests_email_normalized_check",
      sql`${table.email} = lower(btrim(${table.email}))`,
    ),
    check(
      "magic_link_requests_provider_revision_check",
      sql`${table.providerRevision} > 0`,
    ),
    check("magic_link_requests_attempts_check", sql`${table.attempts} >= 0`),
    vocabularyCheck(
      "magic_link_requests_purpose_check",
      table.purpose,
      magicLinkPurposes,
    ),
    vocabularyCheck(
      "magic_link_requests_send_status_check",
      table.sendStatus,
      magicLinkSendStatuses,
    ),
    // A link has its token, browser and code. Word that access was removed has none, and
    // nothing to resume.
    check(
      "magic_link_requests_purpose_fields_check",
      sql`(${table.purpose} = 'link' and ${table.tokenIdentifier} is not null and ${table.browserHash} is not null and ${table.codeHmac} is not null) or (${table.purpose} = 'access_removed' and ${table.tokenIdentifier} is null and ${table.browserHash} is null and ${table.codeHmac} is null and ${table.pendingOauthQuery} is null)`,
    ),
    check(
      "magic_link_requests_send_error_check",
      sql`${table.sendStatus} = 'failed' or (${table.postmarkErrorCode} is null and ${table.postmarkHttpStatus} is null)`,
    ),
    // The limits count what did not fail. An address has few rows; an organisation's
    // count stops at its cap, on this index.
    index("magic_link_requests_email_created_at_idx")
      .on(table.email, table.createdAt)
      .where(sql`${table.sendStatus} <> 'failed'`),
    index("magic_link_requests_organization_created_at_idx")
      .on(table.organizationId, table.createdAt)
      .where(sql`${table.sendStatus} <> 'failed'`),
    // The failure budgets add up attempts by client and by organisation, and only a row
    // somebody guessed at counts, which is few of them.
    index("magic_link_requests_client_attempted_idx")
      .on(table.clientHash, table.createdAt)
      .where(sql`${table.attempts} > 0`),
    index("magic_link_requests_organization_attempted_idx")
      .on(table.organizationId, table.createdAt)
      .where(sql`${table.attempts} > 0`),
    index("magic_link_requests_browser_hash_idx").on(table.browserHash),
    index("magic_link_requests_created_at_idx").on(table.createdAt),
  ],
).enableRLS();
