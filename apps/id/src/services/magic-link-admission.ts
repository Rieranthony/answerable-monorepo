import { and, eq, exists, inArray, isNull, not, sql } from "drizzle-orm";
import { z } from "zod";

import type { Executor } from "../db/client.ts";
import { isEffective } from "../db/queries/effective.ts";
import {
  accounts,
  members,
  organizationDomains,
  organizations,
  ssoProviders,
  systemBindings,
  users,
} from "../db/schema/index.ts";
import { maxLoginAddressLength } from "../http/pages/login-routing.ts";
import { isPublicMailDomain } from "../lib/public-mail-domains.ts";

/** An address as `users.email` holds it, and its domain. */
export type MagicLinkAddress = { email: string; domain: string };

/** Better Auth's plugin parses with this too, so what passes here cannot throw there. */
const pluginAddress = z.email();

/** The one parser, before anything is spent. Its length check runs before any pattern. */
export function parseMagicLinkAddress(raw: string): MagicLinkAddress | null {
  if (raw.length > maxLoginAddressLength) return null;
  const email = raw.trim().toLowerCase();
  if (!pluginAddress.safeParse(email).success) return null;
  return { email, domain: email.slice(email.indexOf("@") + 1) };
}

/** The firm an address belongs to, and the magic-link row at this moment. */
type MagicLinkFirm = {
  organizationId: string;
  firmName: string;
  providerId: string;
  providerRevision: number;
};

/**
 * Who a link would sign in: a member; in domain mode, a user with no membership here yet, or
 * an address no user holds yet. Only the first two have a `userId` to read.
 */
export type AdmittedPerson =
  | { kind: "member"; userId: string; memberId: string }
  | { kind: "user"; userId: string }
  | { kind: "new" };

/**
 * Whether this address may have a link at this moment. `admit` is a person the firm lists, or
 * anyone at a proved domain of a firm in domain mode; `removed` is one whose access ended, who
 * is told so by mail and gets no token; `stranger` is everyone else, and nothing is sent or
 * written.
 */
export type MagicLinkAdmission =
  | { outcome: "stranger" }
  | ({ outcome: "removed" } & MagicLinkFirm)
  | ({ outcome: "admit"; person: AdmittedPerson } & MagicLinkFirm);

/**
 * Of these users, those holding an account whose provider row is another firm's, or that no
 * row names. A firm's own provider rows stay in the table after they are removed, so one of
 * its directory's accounts never counts. `(issuer, account_id)` is unique, so an account with
 * another firm's magic-link row could never sign in here either.
 */
export async function usersWithForeignAccounts(
  tx: Executor,
  userIds: string[],
  organizationId: string,
) {
  const rows = await tx
    .selectDistinct({ userId: accounts.userId })
    .from(accounts)
    .leftJoin(ssoProviders, eq(ssoProviders.providerId, accounts.providerId))
    .where(
      and(
        inArray(accounts.userId, userIds),
        isNull(accounts.deletedAt),
        sql`${ssoProviders.organizationId} is distinct from ${organizationId}`,
      ),
    );
  return new Set(rows.map(({ userId }) => userId));
}

/**
 * The one admission check, read from current state in the caller's transaction, which
 * must be in protocol scope for RLS to show members. Holds no locks of its own, so a
 * caller that goes on to sign someone in takes its locks first.
 */
export async function admitMagicLink(
  tx: Executor,
  { email, domain }: MagicLinkAddress,
): Promise<MagicLinkAdmission> {
  // Before any row: an old domain row fails closed when the list grows, in either mode.
  if (isPublicMailDomain(domain)) return { outcome: "stranger" };
  const [row] = await tx
    .select({
      organizationId: organizations.id,
      firmName: organizations.name,
      providerId: ssoProviders.id,
      providerRevision: ssoProviders.revision,
      admission: ssoProviders.admission,
      domainProvedAt: organizationDomains.verifiedAt,
    })
    .from(organizationDomains)
    .innerJoin(
      organizations,
      eq(organizations.id, organizationDomains.organizationId),
    )
    .innerJoin(
      ssoProviders,
      and(
        eq(ssoProviders.organizationId, organizations.id),
        eq(ssoProviders.kind, "magic_link"),
        isNull(ssoProviders.deletedAt),
        eq(ssoProviders.enabled, true),
      ),
    )
    .where(
      and(
        eq(organizationDomains.domain, domain),
        eq(organizationDomains.status, "active"),
        isNull(organizationDomains.deletedAt),
        eq(organizations.status, "active"),
        isNull(organizations.deletedAt),
        not(
          exists(
            tx
              .select({ organizationId: systemBindings.organizationId })
              .from(systemBindings)
              .where(eq(systemBindings.organizationId, organizations.id)),
          ),
        ),
      ),
    );
  if (!row) return { outcome: "stranger" };
  const { admission, domainProvedAt, ...firm } = row;
  // Per address: a domain added after the switch, not yet proved, admits nobody new.
  const openToAnyone = admission === "domain" && domainProvedAt !== null;

  const [user] = await tx
    .select({
      id: users.id,
      status: users.status,
      retiredEmail: users.retiredEmail,
    })
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)));
  if (!user)
    return openToAnyone
      ? { outcome: "admit", person: { kind: "new" }, ...firm }
      : { outcome: "stranger" };
  if (user.retiredEmail !== null) return { outcome: "stranger" };
  if (user.status !== "active") return { outcome: "removed", ...firm };

  const [member] = await tx
    .select({
      id: members.id,
      status: members.status,
      effective: isEffective(members),
    })
    .from(members)
    .where(
      and(
        eq(members.organizationId, firm.organizationId),
        eq(members.userId, user.id),
      ),
    );
  if (!member && !openToAnyone) return { outcome: "stranger" };
  if (member?.status === "revoked") return { outcome: "removed", ...firm };
  if (member && !member.effective) return { outcome: "stranger" };
  const foreign = await usersWithForeignAccounts(
    tx,
    [user.id],
    firm.organizationId,
  );
  if (foreign.size) return { outcome: "stranger" };

  return {
    outcome: "admit",
    person: member
      ? { kind: "member", userId: user.id, memberId: member.id }
      : { kind: "user", userId: user.id },
    ...firm,
  };
}
