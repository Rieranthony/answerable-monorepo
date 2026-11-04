import {
  and,
  desc,
  eq,
  getTableColumns,
  isNull,
  lt,
  ne,
  sql,
} from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { withDatabaseScope } from "../db/isolation.ts";
import { lockOrganization, lockUser } from "../db/locks.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import {
  accounts,
  magicLinkRequests,
  organizationDomains,
  ssoProviders,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { boundedUserAgent } from "../lib/user-agent.ts";
import { directoryIdOf } from "../services/federation.ts";
import { holderAwaitingDirectory } from "../services/magic-link-admission.ts";
import { lockMagicLinkAddress } from "../services/magic-link-requests.ts";
import {
  recordMagicLinkRefusal,
  type MagicLinkClient,
} from "./magic-link-confirm.ts";
import { magicLinkBrowserHash, magicLinkCodeAttempts } from "./magic-link.ts";

/** The newest connection this browser is waiting on, for the page that asks for its code. */
export async function findDirectoryConnection(db: Database, browser: string) {
  return withDatabaseScope(db, { kind: "protocol" }, async (tx) => {
    const [row] = await tx
      .select({
        email: magicLinkRequests.email,
        pendingOauthQuery: magicLinkRequests.pendingOauthQuery,
      })
      .from(magicLinkRequests)
      .where(
        and(
          eq(magicLinkRequests.browserHash, magicLinkBrowserHash(browser)),
          eq(magicLinkRequests.purpose, "connect_directory"),
          ne(magicLinkRequests.sendStatus, "failed"),
          sql`${magicLinkRequests.expiresAt} > statement_timestamp()`,
          lt(magicLinkRequests.attempts, magicLinkCodeAttempts),
        ),
      )
      .orderBy(desc(magicLinkRequests.createdAt), desc(magicLinkRequests.id))
      .limit(1);
    return row ?? null;
  });
}

class Refusal extends Error {
  constructor(
    readonly reason:
      "directory_changed" | "ended" | "identity_taken" | "not_connectable",
  ) {
    super(reason);
  }
}

/**
 * The right code's work: the directory's account on the same user, in one transaction, under a
 * confirmation's lock order. Everything that let the request be made is read again, since a
 * person can be removed, a domain lost or a directory changed in the ten minutes it lives. It
 * makes no session and no cookie: the caller sends the person through the directory again, and
 * that sign-in, by the ordinary path, is what signs them in.
 *
 * It answers what the caller needs to do that, or null for a refusal, which ends the row and
 * leaves one audit row after whatever it rolled back.
 */
export async function connectDirectoryAccount(
  db: Database,
  matched: typeof magicLinkRequests.$inferSelect,
  who: MagicLinkClient,
) {
  try {
    return await withDatabaseScope(db, { kind: "protocol" }, async (tx) => {
      await lockMagicLinkAddress(tx, matched.email);
      const [holder] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, matched.email));
      if (holder) await lockUser(tx, holder.id, "share");
      const firm = await lockOrganization(tx, matched.organizationId, "share");
      const [directory] = await tx
        .select({
          providerId: ssoProviders.providerId,
          kind: ssoProviders.kind,
          revision: ssoProviders.revision,
          deletedAt: ssoProviders.deletedAt,
        })
        .from(ssoProviders)
        .where(eq(ssoProviders.id, matched.providerId))
        .for("share");
      const [row] = await tx
        .select({
          ...getTableColumns(magicLinkRequests),
          live: sql<boolean>`${magicLinkRequests.expiresAt} > statement_timestamp()`,
        })
        .from(magicLinkRequests)
        .where(eq(magicLinkRequests.id, matched.id))
        .for("update");
      if (
        !row?.live ||
        row.sendStatus !== "sent" ||
        row.attempts > magicLinkCodeAttempts
      )
        throw new Refusal("ended");
      if (
        !directory ||
        directory.kind !== "oidc" ||
        directory.deletedAt !== null ||
        directory.revision !== row.providerRevision
      )
        throw new Refusal("directory_changed");
      const domain = row.email.slice(row.email.lastIndexOf("@") + 1);
      const [domainHeld] = await tx
        .select({ id: organizationDomains.id })
        .from(organizationDomains)
        .where(
          and(
            eq(organizationDomains.organizationId, row.organizationId),
            eq(organizationDomains.domain, domain),
            eq(organizationDomains.status, "active"),
            isNull(organizationDomains.deletedAt),
          ),
        );
      const eligible = await holderAwaitingDirectory(
        tx,
        row.organizationId,
        row.email,
      );
      // A holder who appeared after the lock above was taken has no lock here.
      if (
        firm?.status !== "active" ||
        !domainHeld ||
        !holder ||
        eligible !== holder.id
      )
        throw new Refusal("not_connectable");
      const userId = holder.id;
      // Either key may be held by now: `(issuer, subject)` or the directory's own user id.
      const [account] = await tx
        .insert(accounts)
        .values({
          id: createId(),
          userId,
          providerId: directory.providerId,
          issuer: row.directoryIssuer!,
          accountId: row.directorySubject!,
          directoryId: directoryIdOf(row.directoryIssuer!, domain),
          directoryUserId: row.directoryUserId,
        })
        .onConflictDoNothing()
        .returning({ id: accounts.id });
      if (!account) throw new Refusal("identity_taken");
      await recordAuditEvent(tx, {
        actorType: "user",
        actorId: userId,
        organizationId: row.organizationId,
        action: "identity.linked",
        targetType: "account",
        targetId: account.id,
        outcome: "success",
        ...who,
        userAgent: boundedUserAgent(who.userAgent),
        data: {
          magicLinkRequestId: row.id,
          authenticationProviderId: row.providerId,
          authenticationProviderRevision: row.providerRevision,
          upstreamAuthTime: null,
        },
      });
      // A right code is not a wrong code, so it takes back the attempt it counted.
      await tx
        .update(magicLinkRequests)
        .set({
          expiresAt: sql`statement_timestamp()`,
          attempts: sql`${magicLinkRequests.attempts} - 1`,
        })
        .where(eq(magicLinkRequests.id, row.id));
      return {
        organizationSlug: firm.slug,
        email: row.email,
        pendingQuery: row.pendingOauthQuery,
      };
    });
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    await recordMagicLinkRefusal(
      db,
      matched,
      "auth.magic_link.refused",
      error.reason,
      who,
    );
    return null;
  }
}
