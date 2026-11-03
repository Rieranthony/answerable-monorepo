import type {
  PlatformReadContext,
  PlatformWriteContext,
} from "../../services/platform-context.ts";
import type { TenantReadContext } from "../../services/tenant-context.ts";
import { lockOrganization } from "../locks.ts";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  sql,
  isNull,
} from "drizzle-orm";
import type { Executor } from "../client.ts";
import {
  organizations,
  oauthClients,
  members,
  groups,
  groupMembers,
  entitlements,
  organizationCapabilities,
  organizationDomains,
  ssoProviders,
  systemBindings,
} from "../schema/index.ts";
import type {
  LifecycleStatus,
  MagicLinkAdmissionMode,
} from "../schema/vocabulary.ts";
import type { PageQuery } from "../../http/pagination.ts";
import { beforeCursor, cursorPage, optionalEq, contains } from "./lists.ts";
import { createId } from "../../lib/id.ts";
import { softDeleteEntitlements } from "./entitlements.ts";
import { softDeleteAssignments } from "./groups.ts";
import { isEffective } from "./effective.ts";
import { memberEvidence } from "./members.ts";

export type OrganizationInput = {
  slug: string;
  name: string;
};
export type OrganizationPatch = {
  name?: string;
};
export type OrganizationQuery = PageQuery & {
  q?: string;
  status?: LifecycleStatus;
};

/** The organisation's one live magic-link row: it has one for as long as it is live. */
const liveMagicLink = (organizationId: typeof organizations.id | string) =>
  and(
    isNull(ssoProviders.deletedAt),
    eq(ssoProviders.organizationId, organizationId),
    eq(ssoProviders.kind, "magic_link"),
  );

const noMagicLink = (organizationId: string) =>
  new Error(`Organisation ${organizationId} has no magic-link provider row`);

const magicLinkFields = {
  ...getTableColumns(organizations),
  magicLinkEnabled: ssoProviders.enabled,
  magicLinkAdmission: ssoProviders.admission,
};

/** An organisation as a list shows it. A left join, so that a missing row fails in
 * `shownOrganization` instead of hiding the organisation from a list. */
const organizationsShown = (tx: Executor) =>
  tx
    .select(magicLinkFields)
    .from(organizations)
    .leftJoin(ssoProviders, liveMagicLink(organizations.id));

function shownOrganization({
  magicLinkEnabled,
  magicLinkAdmission,
  ...row
}: Awaited<ReturnType<typeof organizationsShown>>[number]) {
  if (magicLinkEnabled === null || magicLinkAdmission === null)
    throw noMagicLink(row.id);
  return {
    ...row,
    magicLink: { enabled: magicLinkEnabled, admission: magicLinkAdmission },
  };
}

/** One organisation, with how many effective members it lists. A list leaves that count out:
 * measured on a page of 100 firms of 5,000 members each, it takes 745 ms and 505,672 buffers
 * against 1 ms without it, every page, in a transaction. */
async function readLiveOrganization(tx: Executor, id: string) {
  const [row] = await tx
    .select({
      ...magicLinkFields,
      magicLinkListed: sql<number>`(
        select count(*)::int from ${members}
        where ${members.organizationId} = ${organizations.id} and ${isEffective(members)}
      )`,
    })
    .from(organizations)
    .leftJoin(ssoProviders, liveMagicLink(organizations.id))
    .where(and(isNull(organizations.deletedAt), eq(organizations.id, id)));
  const { magicLinkListed: listed, ...shown } = row!;
  const organization = shownOrganization(shown);
  return {
    ...organization,
    magicLink: { ...organization.magicLink, listed },
  };
}

export async function listOrganizations(
  context: PlatformReadContext,
  query: OrganizationQuery,
) {
  const { tx: executor } = context;
  return cursorPage(
    (
      await organizationsShown(executor)
        .where(
          and(
            isNull(organizations.deletedAt),
            contains(query.q, organizations.name, organizations.slug),
            optionalEq(organizations.status, query.status),
            beforeCursor(organizations.id, query.cursor),
          ),
        )
        .orderBy(desc(organizations.id))
        .limit(query.limit + 1)
    ).map(shownOrganization),
    query.limit,
  );
}

/** withTenantRead has share-locked the live row and answered 404 without it. */
export async function readOrganization(
  context: TenantReadContext<"directory">,
) {
  const { tx, organizationId } = context;
  return readLiveOrganization(tx, organizationId);
}

/** What a command answers: the live organisation it just changed, as a read shows it. */
export async function answerOrganization(
  context: PlatformWriteContext,
  id: string,
) {
  return readLiveOrganization(context.tx, id);
}

/** Caller holds the organisation lock. */
export async function lockMagicLinkForCommand(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx } = context;
  const [row] = await tx
    .select()
    .from(ssoProviders)
    .where(liveMagicLink(organizationId))
    .for("update");
  if (!row) throw noMagicLink(organizationId);
  return row;
}

/** The revision guard moves the row's revision: the setting and it cannot disagree. */
export async function setMagicLinkEnabled(
  context: PlatformWriteContext,
  id: string,
  enabled: boolean,
) {
  const { tx } = context;
  const [row] = await tx
    .update(ssoProviders)
    .set({ enabled })
    .where(eq(ssoProviders.id, id))
    .returning();
  return row!;
}

/** Who may ask for a link. The revision guard ignores this column: it ends no session. */
export async function setMagicLinkAdmission(
  context: PlatformWriteContext,
  id: string,
  admission: MagicLinkAdmissionMode,
) {
  const { tx } = context;
  const [row] = await tx
    .update(ssoProviders)
    .set({ admission })
    .where(eq(ssoProviders.id, id))
    .returning();
  return row!;
}

export async function isPlatformOrganization(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx } = context;
  const [binding] = await tx
    .select({ name: systemBindings.name })
    .from(systemBindings)
    .where(eq(systemBindings.organizationId, organizationId));
  return binding !== undefined;
}

export async function readOrganizationStatus(
  context: TenantReadContext<"memberAccess">,
) {
  const { tx, organizationId } = context;
  const [row] = await tx
    .select({
      id: organizations.id,
      slug: organizations.slug,
      status: organizations.status,
    })
    .from(organizations)
    .where(
      and(
        isNull(organizations.deletedAt),
        eq(organizations.id, organizationId),
      ),
    );
  return row ?? null;
}

export async function organizationExistsForHistory(
  context: TenantReadContext<"history">,
) {
  const { tx, organizationId } = context;
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        isNull(organizations.deletedAt),
        eq(organizations.id, organizationId),
      ),
    );
  return row !== undefined;
}

export async function lockOrganizationForCommand(
  context: PlatformWriteContext,
  organizationId: string,
) {
  return lockOrganization(context.tx, organizationId);
}

export async function createOrganization(
  context: PlatformWriteContext,
  input: OrganizationInput,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .insert(organizations)
    .values({ ...input, id: createId() })
    .returning();
  return row!;
}

export async function updateOrganization(
  context: PlatformWriteContext,
  id: string,
  patch: OrganizationPatch,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(organizations)
    .set(patch)
    .where(and(isNull(organizations.deletedAt), eq(organizations.id, id)))
    .returning();
  return row ?? null;
}

export async function setOrganizationStatus(
  context: PlatformWriteContext,
  id: string,
  status: LifecycleStatus,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(organizations)
    .set({ status, disabledAt: status === "disabled" ? sql`now()` : null })
    .where(and(isNull(organizations.deletedAt), eq(organizations.id, id)))
    .returning();
  return row ?? null;
}

export async function countOrganizationClients(
  context: PlatformWriteContext,
  id: string,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .select({ count: count() })
    .from(oauthClients)
    .where(
      and(isNull(oauthClients.deletedAt), eq(oauthClients.organizationId, id)),
    );
  return row!.count;
}

/** Delete children explicitly so erasure evidence comes from actual removed rows.
 * Caller holds the organisation lock and removes grant contexts first.
 * Return only policy/identity fields; provider credentials stay out.
 */
export async function deleteOrganization(
  context: PlatformWriteContext,
  organizationId: string,
) {
  const { tx } = context;
  const softDeletedEntitlements = await softDeleteEntitlements(
    tx,
    eq(entitlements.organizationId, organizationId),
  );
  const softDeletedAssignments = await softDeleteAssignments(
    tx,
    eq(groupMembers.organizationId, organizationId),
  );
  const softDeletedMembers = await tx
    .update(members)
    .set({
      deletedAt: sql`now()`,
      status: "revoked",
      revokedAt: sql`coalesce(${members.revokedAt}, now())`,
    })
    .where(
      and(
        isNull(members.deletedAt),
        eq(members.organizationId, organizationId),
      ),
    )
    .returning({ ...memberEvidence, deletedAt: members.deletedAt });
  const softDeletedGroups = await tx
    .update(groups)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(isNull(groups.deletedAt), eq(groups.organizationId, organizationId)),
    )
    .returning({
      deletedAt: groups.deletedAt,
      id: groups.id,
      organizationId: groups.organizationId,
      revision: groups.revision,
      slug: groups.slug,
      status: groups.status,
    });
  const softDeletedCapabilities = await tx
    .update(organizationCapabilities)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        isNull(organizationCapabilities.deletedAt),
        eq(organizationCapabilities.organizationId, organizationId),
      ),
    )
    .returning({
      deletedAt: organizationCapabilities.deletedAt,
      id: organizationCapabilities.id,
      organizationId: organizationCapabilities.organizationId,
      revision: organizationCapabilities.revision,
      clientId: organizationCapabilities.clientId,
      resource: organizationCapabilities.resource,
      grantKind: organizationCapabilities.grantKind,
      scopes: organizationCapabilities.scopes,
      status: organizationCapabilities.status,
      validFrom: organizationCapabilities.validFrom,
      validUntil: organizationCapabilities.validUntil,
    });
  const softDeletedDomains = await tx
    .update(organizationDomains)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.organizationId, organizationId),
      ),
    )
    .returning({
      deletedAt: organizationDomains.deletedAt,
      id: organizationDomains.id,
      organizationId: organizationDomains.organizationId,
      domain: organizationDomains.domain,
      status: organizationDomains.status,
    });
  const softDeletedSsoProviders = await tx
    .update(ssoProviders)
    .set({ deletedAt: sql`now()`, oidcConfig: null })
    .where(
      and(
        isNull(ssoProviders.deletedAt),
        eq(ssoProviders.organizationId, organizationId),
      ),
    )
    .returning({
      deletedAt: ssoProviders.deletedAt,
      id: ssoProviders.id,
      organizationId: ssoProviders.organizationId,
      revision: ssoProviders.revision,
      providerId: ssoProviders.providerId,
      issuer: ssoProviders.issuer,
      domain: ssoProviders.domain,
    });
  const [row] = await tx
    .update(organizations)
    .set({ deletedAt: sql`now()`, status: "disabled", disabledAt: sql`now()` })
    .where(
      and(
        isNull(organizations.deletedAt),
        eq(organizations.id, organizationId),
      ),
    )
    .returning();
  return {
    row: row!,
    effects: {
      softDeletedEntitlements,
      softDeletedAssignments,
      softDeletedMembers,
      softDeletedGroups,
      softDeletedCapabilities,
      softDeletedDomains,
      softDeletedSsoProviders,
    },
  };
}
