import { sql } from "drizzle-orm";
import {
  boolean,
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
 * see a suppressed address. `connect_directory` is the other proof of a directory added after
 * a magic link: its code connects an account, signs nobody in, and has no token.
 */
export const magicLinkRequests = pgTable(
  "magic_link_requests",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The magic-link row and its revision at issue, or on `connect_directory` the directory's
     * row and revision. No key, as a session's origin has none: an insert here must take no
     * lock on a row that commands update. */
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
    /** No user held this address when it was asked for, which only domain mode admits. Made-up
     * addresses count here, so a budget of their own can stop them bouncing. */
    newAddress: boolean("new_address").default(false).notNull(),
    /** The signed query of the authorisation this sign-in resumes. */
    pendingOauthQuery: text("pending_oauth_query"),
    /** The verified directory identity a `connect_directory` code connects, and nothing more
     * of that sign-in: what `accounts` keys on. */
    directoryIssuer: text("directory_issuer"),
    directorySubject: text("directory_subject"),
    directoryUserId: text("directory_user_id"),
    expiresAt: timestampColumn("expires_at").notNull(),
    sendStatus: text("send_status", { enum: magicLinkSendStatuses })
      .default("sent")
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
    // A link has its token, browser and code. A directory's connection has a browser, a code and
    // the identity, and no token, since its code signs nobody in; it is never a new address.
    check(
      "magic_link_requests_purpose_fields_check",
      sql`(${table.purpose} = 'link' and ${table.tokenIdentifier} is not null and ${table.browserHash} is not null and ${table.codeHmac} is not null and ${table.directoryIssuer} is null and ${table.directorySubject} is null and ${table.directoryUserId} is null) or (${table.purpose} = 'connect_directory' and ${table.tokenIdentifier} is null and ${table.browserHash} is not null and ${table.codeHmac} is not null and ${table.directoryIssuer} is not null and ${table.directorySubject} is not null and ${table.directoryUserId} is not null and not ${table.newAddress})`,
    ),
    check(
      "magic_link_requests_send_error_check",
      sql`${table.sendStatus} = 'failed' or (${table.postmarkErrorCode} is null and ${table.postmarkHttpStatus} is null)`,
    ),
    // The limits read one address's rows, which they themselves keep few; so do diagnosis and
    // freeing an address, which read failed rows too.
    index("magic_link_requests_email_created_at_idx").on(
      table.email,
      table.createdAt,
    ),
    // What the budgets for addresses nobody holds count, and only those rows are in them.
    index("magic_link_requests_new_address_organization_idx")
      .on(table.organizationId, table.createdAt)
      .where(sql`${table.newAddress} and ${table.sendStatus} <> 'failed'`),
    index("magic_link_requests_new_address_client_idx")
      .on(table.clientHash, table.createdAt)
      .where(sql`${table.newAddress} and ${table.sendStatus} <> 'failed'`),
    index("magic_link_requests_browser_hash_idx").on(table.browserHash),
    index("magic_link_requests_created_at_idx").on(table.createdAt),
  ],
).enableRLS();
