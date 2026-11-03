import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { magicLinkIssuer } from "../../auth/magic-link.ts";
import type { PlatformWriteContext } from "../../services/platform-context.ts";
import type { TenantReadContext } from "../../services/tenant-context.ts";
import type { Executor } from "../client.ts";
import { withDatabaseScope } from "../isolation.ts";
import {
  accounts,
  grantContexts,
  magicLinkRequests,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "../schema/index.ts";
import { revokeGrantContexts } from "./grant-contexts.ts";

/** The firm's magic-link setting. A live firm's row exists, as every read assumes; a firm the
 * read cannot see has no setting to report. */
export async function readMagicLinkSetting(
  context: TenantReadContext<"memberAccess">,
) {
  const { tx, organizationId } = context;
  const [row] = await tx
    .select({ enabled: ssoProviders.enabled })
    .from(ssoProviders)
    .where(
      and(
        eq(ssoProviders.organizationId, organizationId),
        eq(ssoProviders.kind, "magic_link"),
        isNull(ssoProviders.deletedAt),
      ),
    );
  return row?.enabled ?? false;
}

/** The newest sign-in mail for this exact address at this firm, for diagnosis. */
export async function readLastMagicLinkRequest(
  context: TenantReadContext<"memberAccess">,
  email: string,
) {
  const { tx, organizationId } = context;
  const [row] = await tx
    .select({
      id: magicLinkRequests.id,
      purpose: magicLinkRequests.purpose,
      sendStatus: magicLinkRequests.sendStatus,
      postmarkErrorCode: magicLinkRequests.postmarkErrorCode,
      postmarkHttpStatus: magicLinkRequests.postmarkHttpStatus,
      createdAt: magicLinkRequests.createdAt,
    })
    .from(magicLinkRequests)
    .where(
      and(
        eq(magicLinkRequests.organizationId, organizationId),
        eq(magicLinkRequests.email, email),
      ),
    )
    .orderBy(desc(magicLinkRequests.createdAt), desc(magicLinkRequests.id))
    .limit(1);
  return row ? { ...row, createdAt: row.createdAt.toISOString() } : null;
}

/**
 * A domain is what a magic link's authority rests on, so when it stops being the firm's, the
 * sessions and grants of its addresses end. The rest of the firm is untouched: its row is per
 * firm, so no revision moves, and a directory's sessions name another account. The caller
 * holds the organisation, which a confirmation holds a share of, so a confirmation either
 * committed first and is found here, or waits and finds the domain gone.
 */
export async function endMagicLinkUseOfDomain(
  context: PlatformWriteContext,
  organizationId: string,
  domain: string,
) {
  const { tx } = context;
  const accountsAtDomain = tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.issuer, magicLinkIssuer),
        eq(accounts.providerId, `magic-link:${organizationId}`),
        sql`split_part(${accounts.accountId}, '@', 2) = ${domain}`,
      ),
    );
  const revokedGrantContexts = await revokeGrantContexts(
    tx,
    and(
      eq(grantContexts.organizationId, organizationId),
      inArray(grantContexts.authenticationAccountId, accountsAtDomain),
    )!,
  ).returning({ id: grantContexts.id, userId: grantContexts.userId });
  const deletedSessions = await tx
    .delete(sessions)
    .where(
      and(
        eq(sessions.authenticationOrganizationId, organizationId),
        inArray(sessions.authenticationAccountId, accountsAtDomain),
      ),
    )
    .returning({ id: sessions.id, userId: sessions.userId });
  return { revokedGrantContexts, deletedSessions };
}

/**
 * Free an address when its holder is retired or erased. `accounts_issuer_account_id_unique`
 * is not partial, so without this the address could never be listed again. The old identity
 * cannot be reused, since the key holds no address, and nothing here keeps it: its requests
 * and their tokens go too, or an erased person's address would sit in a row for seven days.
 */
export async function releaseMagicLinkAddress(tx: Executor, userId: string) {
  const [{ email }] = (await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))) as [{ email: string }];
  await tx
    .update(accounts)
    .set({ accountId: sql`'retired:' || ${accounts.id}::text` })
    .where(
      and(eq(accounts.userId, userId), eq(accounts.issuer, magicLinkIssuer)),
    );
  await withDatabaseScope(tx, { kind: "protocol" }, async (scoped) => {
    const requests = await scoped
      .delete(magicLinkRequests)
      .where(eq(magicLinkRequests.email, email))
      .returning({ identifier: magicLinkRequests.tokenIdentifier });
    await scoped.delete(verifications).where(
      inArray(
        verifications.identifier,
        requests.flatMap(({ identifier }) => identifier ?? []),
      ),
    );
  });
}
