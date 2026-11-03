import { and, eq, exists, isNull, not, sql } from "drizzle-orm";
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
 * Whether this address may have a link at this moment. `admit` is a person the firm lists;
 * `removed` is one whose access ended, who is told so by mail and gets no token; `stranger`
 * is everyone else, and nothing is sent or written.
 */
export type MagicLinkAdmission =
  | { outcome: "stranger" }
  | ({ outcome: "removed" } & MagicLinkFirm)
  | ({ outcome: "admit"; userId: string; memberId: string } & MagicLinkFirm);

/**
 * The one admission check, read from current state in the caller's transaction, which
 * must be in protocol scope for RLS to show members. Holds no locks of its own, so a
 * caller that goes on to sign someone in takes its locks first.
 */
export async function admitMagicLink(
  tx: Executor,
  { email, domain }: MagicLinkAddress,
): Promise<MagicLinkAdmission> {
  const [firm] = await tx
    .select({
      organizationId: organizations.id,
      firmName: organizations.name,
      providerId: ssoProviders.id,
      providerRevision: ssoProviders.revision,
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
  if (!firm) return { outcome: "stranger" };

  const [user] = await tx
    .select({
      id: users.id,
      status: users.status,
      retiredEmail: users.retiredEmail,
    })
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)));
  if (!user || user.retiredEmail !== null) return { outcome: "stranger" };
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
  if (!member) return { outcome: "stranger" };
  if (member.status === "revoked") return { outcome: "removed", ...firm };
  if (!member.effective) return { outcome: "stranger" };

  // An account whose provider row is another firm's, or that no row names. A firm's own
  // provider rows stay in the table after they are removed, so one of its directory's
  // accounts never counts. `(issuer, account_id)` is unique, so an account with another
  // firm's magic-link row could never sign in here either.
  const [foreign] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .leftJoin(ssoProviders, eq(ssoProviders.providerId, accounts.providerId))
    .where(
      and(
        eq(accounts.userId, user.id),
        isNull(accounts.deletedAt),
        sql`${ssoProviders.organizationId} is distinct from ${firm.organizationId}`,
      ),
    )
    .limit(1);
  if (foreign) return { outcome: "stranger" };

  return { outcome: "admit", userId: user.id, memberId: member.id, ...firm };
}
