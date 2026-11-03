import type { Executor } from "../client.ts";
import { sql, and, desc, eq, exists, isNull } from "drizzle-orm";
import type { PlatformWriteContext } from "../../services/platform-context.ts";
import type { TenantReadContext } from "../../services/tenant-context.ts";
import type { PageQuery } from "../../http/pagination.ts";
import { beforeCursor, cursorPage, optionalEq } from "./lists.ts";
import type { LifecycleStatus } from "../schema/vocabulary.ts";

import { createId } from "../../lib/id.ts";
import {
  organizationDomains,
  organizations,
  ssoProviders,
} from "../schema/index.ts";

export async function createOrganizationDomain(
  context: PlatformWriteContext,
  input: { organizationId: string; domain: string },
) {
  const { tx: db } = context;
  const [domain] = await db
    .insert(organizationDomains)
    .values({
      id: createId(),
      organizationId: input.organizationId,
      domain: input.domain,
    })
    .returning();

  return domain!;
}

/** Whether this tenant currently accepts the domain; never returns a foreign identity.
 * Domains arrive normalised: the HTTP boundary lowercases and validates them. */
export async function organizationAcceptsDomain(
  context: TenantReadContext<"memberAccess">,
  domain: string,
) {
  const { tx: db, organizationId } = context;
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizationDomains)
    .innerJoin(
      organizations,
      eq(organizationDomains.organizationId, organizations.id),
    )
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.domain, domain),
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.status, "active"),
        eq(organizations.status, "active"),
      ),
    )
    .limit(1);

  return organization !== undefined;
}

/** How the firm offers sign-in. One read, the same whatever the address it was asked for. */
const signInMethods = (db: Executor) => ({
  slug: organizations.slug,
  directory: sql<boolean>`${exists(
    db
      .select({ id: ssoProviders.id })
      .from(ssoProviders)
      .where(
        and(
          eq(ssoProviders.organizationId, organizations.id),
          eq(ssoProviders.kind, "oidc"),
          isNull(ssoProviders.deletedAt),
        ),
      ),
  )}`,
  magicLink: sql<boolean>`${exists(
    db
      .select({ id: ssoProviders.id })
      .from(ssoProviders)
      .where(
        and(
          eq(ssoProviders.organizationId, organizations.id),
          eq(ssoProviders.kind, "magic_link"),
          eq(ssoProviders.enabled, true),
          isNull(ssoProviders.deletedAt),
        ),
      ),
  )}`,
});

/** The firm that holds this domain, and how it offers sign-in. */
export async function findDomainSignInRoute(db: Executor, domain: string) {
  const [route] = await db
    .select(signInMethods(db))
    .from(organizationDomains)
    .innerJoin(
      organizations,
      eq(organizationDomains.organizationId, organizations.id),
    )
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.domain, domain),
        eq(organizationDomains.status, "active"),
        eq(organizations.status, "active"),
      ),
    )
    .limit(1);

  return route ?? null;
}

/** Whether `?organization=<slug>` names a firm whose only way in is a link. */
export async function organizationUsesLinksOnly(db: Executor, slug: string) {
  const [route] = await db
    .select(signInMethods(db))
    .from(organizations)
    .where(
      and(
        eq(organizations.slug, slug),
        eq(organizations.status, "active"),
        isNull(organizations.deletedAt),
      ),
    );
  return route !== undefined && route.magicLink && !route.directory;
}

export type DomainQuery = PageQuery & { status?: LifecycleStatus };

export async function listOrganizationDomains(
  context: TenantReadContext<"directory">,
  query: DomainQuery,
) {
  const { tx: executor, organizationId } = context;
  return cursorPage(
    await executor
      .select()
      .from(organizationDomains)
      .where(
        and(
          isNull(organizationDomains.deletedAt),
          eq(organizationDomains.organizationId, organizationId),
          optionalEq(organizationDomains.status, query.status),
          beforeCursor(organizationDomains.id, query.cursor),
        ),
      )
      .orderBy(desc(organizationDomains.id))
      .limit(query.limit + 1),
    query.limit,
  );
}

export async function findOrganizationDomainForCommand(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
) {
  const { tx: executor } = context;
  const query = executor
    .select()
    .from(organizationDomains)
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.id, domainId),
      ),
    );
  const [row] = await query.for("update");
  return row ?? null;
}

export async function setOrganizationDomainStatus(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
  status: LifecycleStatus,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(organizationDomains)
    .set({ status })
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.id, domainId),
      ),
    )
    .returning();
  return row ?? null;
}

/** The proof is the time a record was seen; a stale `verified_at` is never left behind. */
export async function setOrganizationDomainProof(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
  proved: boolean,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(organizationDomains)
    .set({ verifiedAt: proved ? sql`statement_timestamp()` : null })
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.id, domainId),
      ),
    )
    .returning();
  return row ?? null;
}

/** The firm's active domains, for a command that holds the organisation at least in share. */
export async function activeOrganizationDomains(
  tx: Executor,
  organizationId: string,
) {
  return tx
    .select({
      domain: organizationDomains.domain,
      verifiedAt: organizationDomains.verifiedAt,
    })
    .from(organizationDomains)
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.status, "active"),
      ),
    );
}

export async function deleteOrganizationDomain(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(organizationDomains)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.id, domainId),
      ),
    )
    .returning();
  return row ?? null;
}
