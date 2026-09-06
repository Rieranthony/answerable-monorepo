import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "./db/client.ts";
import { recordAuditEvent } from "./db/queries/audit.ts";
import { createEntitlement } from "./db/queries/entitlements.ts";
import { createGroup } from "./db/queries/groups.ts";
import { createOrganizationDomain } from "./db/queries/organization-domains.ts";
import {
  createSsoProvider,
  findSsoProviderByOrganization,
  serializeSsoProviderConfig,
  updateSsoProvider,
} from "./db/queries/sso-providers.ts";
import {
  entitlements,
  groupMembers,
  groups,
  members,
  oauthClientResources,
  oauthClients,
  oauthResources,
  organizationDomains,
  organizations,
  users,
} from "./db/schema/index.ts";
import { EnvironmentValidationError } from "./env.ts";
import { adminScopes, type AdminScope } from "./http/admin/scopes.ts";
import { createId } from "./lib/id.ts";
import {
  generateClientSecret,
  hashClientSecret,
} from "./services/client-secrets.ts";

export const platformScopes = adminScopes.filter(
  (scope): scope is Extract<AdminScope, `platform:${string}`> =>
    scope.startsWith("platform:"),
);
export const platformAdminsGroupSlug = "platform-admins";

export type BootstrapOptions = {
  platformOrganizationSlug: string;
  platformOrganizationName: string;
  platformDomain: string;
  sso: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    discoveryEndpoint?: string;
  };
  adminResourceIdentifier: string;
  bootstrapClientId: string;
};

export type BootstrapResult = {
  organization: {
    id: string;
    slug: string;
    created: boolean;
    updated: boolean;
  };
  domain: { id: string; created: boolean };
  ssoProvider: { id: string; created: boolean; updated: boolean };
  resource: {
    id: string;
    identifier: string;
    created: boolean;
    updated: boolean;
  };
  group: { id: string; created: boolean };
  entitlement: { id: string; created: boolean; updated: boolean };
  client: { clientId: string; created: boolean; clientSecret: string | null };
};

const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

export async function bootstrap(
  db: Database,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  return db.transaction(async (tx) => {
    // Serialise concurrent bootstrap/staff commands, including the first insert.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('answerable:bootstrap'))`,
    );
    const domain = options.platformDomain.trim().toLowerCase();
    let [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.slug, options.platformOrganizationSlug));
    const organizationCreated = !organization;
    const organizationUpdated =
      !!organization && organization.name !== options.platformOrganizationName;
    if (!organization) {
      [organization] = await tx
        .insert(organizations)
        .values({
          id: createId(),
          slug: options.platformOrganizationSlug,
          name: options.platformOrganizationName,
        })
        .returning();
    } else if (organizationUpdated) {
      await tx
        .update(organizations)
        .set({ name: options.platformOrganizationName })
        .where(eq(organizations.id, organization.id));
    }
    const organizationId = organization!.id;
    let [domainRow] = await tx
      .select()
      .from(organizationDomains)
      .where(
        and(
          eq(organizationDomains.organizationId, organizationId),
          eq(organizationDomains.domain, domain),
        ),
      );
    const domainCreated = !domainRow;
    if (!domainRow)
      domainRow = await createOrganizationDomain(tx, {
        organizationId,
        domain,
      });

    const providerInput = {
      organizationId,
      providerId: options.platformOrganizationSlug,
      issuer: options.sso.issuer,
      domain,
      oidc: {
        ...options.sso,
        tokenEndpointAuthentication: "client_secret_post" as const,
      },
    };
    let provider = await findSsoProviderByOrganization(tx, organizationId);
    const providerCreated = !provider;
    const providerUpdated =
      !!provider &&
      (provider.issuer !== providerInput.issuer ||
        provider.domain !== domain ||
        provider.oidcConfig !== serializeSsoProviderConfig(providerInput));
    if (!provider) provider = await createSsoProvider(tx, providerInput);
    else if (providerUpdated)
      provider = await updateSsoProvider(tx, provider.id, providerInput);

    const resourceFields = {
      name: "Answerable ID admin API",
      accessTokenTtl: 600,
      allowedScopes: [...adminScopes],
    };
    let [resource] = await tx
      .select()
      .from(oauthResources)
      .where(eq(oauthResources.identifier, options.adminResourceIdentifier));
    const resourceCreated = !resource;
    const resourceUpdated =
      !!resource &&
      (resource.name !== resourceFields.name ||
        resource.accessTokenTtl !== resourceFields.accessTokenTtl ||
        !same(resource.allowedScopes, resourceFields.allowedScopes));
    if (!resource) {
      [resource] = await tx
        .insert(oauthResources)
        .values({
          id: createId(),
          identifier: options.adminResourceIdentifier,
          ...resourceFields,
        })
        .returning();
    } else if (resourceUpdated) {
      await tx
        .update(oauthResources)
        .set(resourceFields)
        .where(eq(oauthResources.id, resource.id));
    }

    let [group] = await tx
      .select()
      .from(groups)
      .where(
        and(
          eq(groups.organizationId, organizationId),
          eq(groups.slug, platformAdminsGroupSlug),
        ),
      );
    const groupCreated = !group;
    if (!group)
      group = await createGroup(tx, {
        organizationId,
        slug: platformAdminsGroupSlug,
        name: "Platform admins",
      });
    let [entitlement] = await tx
      .select()
      .from(entitlements)
      .where(
        and(
          eq(entitlements.organizationId, organizationId),
          eq(entitlements.groupId, group.id),
          eq(entitlements.resource, options.adminResourceIdentifier),
          isNull(entitlements.memberId),
          isNull(entitlements.clientId),
        ),
      );
    const entitlementCreated = !entitlement;
    const entitlementUpdated =
      !!entitlement && !same(entitlement.scopes, platformScopes);
    if (!entitlement)
      entitlement = await createEntitlement(tx, {
        organizationId,
        groupId: group.id,
        resource: options.adminResourceIdentifier,
        scopes: [...platformScopes],
      });
    else if (entitlementUpdated)
      await tx
        .update(entitlements)
        .set({ scopes: [...platformScopes] })
        .where(eq(entitlements.id, entitlement.id));

    const [client] = await tx
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, options.bootstrapClientId));
    const clientCreated = !client;
    let clientUpdated = false;
    let clientSecret: string | null = null;
    if (!client) {
      clientSecret = generateClientSecret();
      await tx.insert(oauthClients).values({
        id: createId(),
        clientId: options.bootstrapClientId,
        clientSecret: hashClientSecret(clientSecret),
        name: "Answerable bootstrap",
        redirectUris: [],
        grantTypes: ["client_credentials"],
        responseTypes: [],
        tokenEndpointAuthMethod: "client_secret_basic",
        scopes: [],
        clientCredentialsScopes: [...platformScopes],
        organizationId,
        disabled: false,
      });
    } else if (
      client.organizationId !== organizationId ||
      !same(client.clientCredentialsScopes, platformScopes)
    ) {
      clientUpdated = true;
      await tx
        .update(oauthClients)
        .set({ organizationId, clientCredentialsScopes: [...platformScopes] })
        .where(eq(oauthClients.clientId, client.clientId));
    }
    const links = await tx
      .insert(oauthClientResources)
      .values({
        id: createId(),
        clientId: options.bootstrapClientId,
        resourceId: options.adminResourceIdentifier,
      })
      .onConflictDoNothing()
      .returning();
    clientUpdated = !clientCreated && (clientUpdated || links.length > 0);
    await recordAuditEvent(tx, {
      actorType: "system",
      actorId: "bootstrap",
      organizationId,
      action: "bootstrap.applied",
      targetType: "organization",
      targetId: organizationId,
      outcome: "success",
      data: {
        organization: {
          created: organizationCreated,
          updated: organizationUpdated,
        },
        domain: { created: domainCreated, updated: false },
        ssoProvider: { created: providerCreated, updated: providerUpdated },
        resource: { created: resourceCreated, updated: resourceUpdated },
        group: { created: groupCreated, updated: false },
        entitlement: {
          created: entitlementCreated,
          updated: entitlementUpdated,
        },
        client: { created: clientCreated, updated: clientUpdated },
      },
    });
    return {
      organization: {
        id: organizationId,
        slug: organization!.slug,
        created: organizationCreated,
        updated: organizationUpdated,
      },
      domain: { id: domainRow.id, created: domainCreated },
      ssoProvider: {
        id: provider.id,
        created: providerCreated,
        updated: providerUpdated,
      },
      resource: {
        id: resource!.id,
        identifier: resource!.identifier,
        created: resourceCreated,
        updated: resourceUpdated,
      },
      group: { id: group.id, created: groupCreated },
      entitlement: {
        id: entitlement.id,
        created: entitlementCreated,
        updated: entitlementUpdated,
      },
      client: {
        clientId: options.bootstrapClientId,
        created: clientCreated,
        clientSecret,
      },
    };
  });
}

export class PlatformNotBootstrappedError extends Error {
  constructor() {
    super(
      "Platform organisation or platform-admins group missing; run bootstrap first.",
    );
    this.name = "PlatformNotBootstrappedError";
  }
}

export class StaffUserNotFoundError extends Error {
  constructor(email: string) {
    super(
      `Active staff user not found: ${email}. Sign in once before adding staff.`,
    );
    this.name = "StaffUserNotFoundError";
  }
}

export async function addStaff(
  db: Database,
  input: { platformOrganizationSlug: string; email: string },
): Promise<{
  userId: string;
  memberId: string;
  member: { created: boolean };
  groupMember: { created: boolean };
}> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('answerable:bootstrap'))`,
    );
    const [platform] = await tx
      .select({ organizationId: organizations.id, groupId: groups.id })
      .from(organizations)
      .innerJoin(
        groups,
        and(
          eq(groups.organizationId, organizations.id),
          eq(groups.slug, platformAdminsGroupSlug),
        ),
      )
      .where(eq(organizations.slug, input.platformOrganizationSlug));
    if (!platform) throw new PlatformNotBootstrappedError();
    const email = input.email.trim().toLowerCase();
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.email, email), eq(users.status, "active")));
    if (!user) throw new StaffUserNotFoundError(email);
    const inserted = await tx
      .insert(members)
      .values({
        id: createId(),
        organizationId: platform.organizationId,
        userId: user.id,
      })
      .onConflictDoNothing()
      .returning();
    const [member] = await tx
      .select()
      .from(members)
      .where(
        and(
          eq(members.organizationId, platform.organizationId),
          eq(members.userId, user.id),
        ),
      );
    const groupInserted = await tx
      .insert(groupMembers)
      .values({
        organizationId: platform.organizationId,
        groupId: platform.groupId,
        memberId: member!.id,
      })
      .onConflictDoNothing()
      .returning();
    const result = {
      userId: user.id,
      memberId: member!.id,
      member: { created: inserted.length > 0 },
      groupMember: { created: groupInserted.length > 0 },
    };
    await recordAuditEvent(tx, {
      actorType: "system",
      actorId: "bootstrap",
      organizationId: platform.organizationId,
      action: "staff.added",
      targetType: "user",
      targetId: user.id,
      outcome: "success",
      data: {
        email,
        member: result.member.created,
        groupMember: result.groupMember.created,
      },
    });
    return result;
  });
}

export const bootstrapEnvironmentSchema = z
  .object({
    PLATFORM_ORGANIZATION_NAME: z.string().trim().min(1).default("Answerable"),
    PLATFORM_DOMAIN: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .regex(
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
      ),
    PLATFORM_SSO_ISSUER: z.url(),
    PLATFORM_SSO_CLIENT_ID: z.string().min(1),
    PLATFORM_SSO_CLIENT_SECRET: z.string().min(1),
    PLATFORM_SSO_DISCOVERY_ENDPOINT: z.url().optional(),
    BOOTSTRAP_CLIENT_ID: z
      .string()
      .trim()
      .min(1)
      .default("answerable-bootstrap"),
  })
  .transform((source) => ({
    platformOrganizationName: source.PLATFORM_ORGANIZATION_NAME,
    platformDomain: source.PLATFORM_DOMAIN,
    sso: {
      issuer: source.PLATFORM_SSO_ISSUER,
      clientId: source.PLATFORM_SSO_CLIENT_ID,
      clientSecret: source.PLATFORM_SSO_CLIENT_SECRET,
      discoveryEndpoint: source.PLATFORM_SSO_DISCOVERY_ENDPOINT,
    },
    bootstrapClientId: source.BOOTSTRAP_CLIENT_ID,
  }));

export function parseBootstrapEnvironment(
  source: Record<string, string | undefined>,
): z.output<typeof bootstrapEnvironmentSchema> {
  const result = bootstrapEnvironmentSchema.safeParse(source);
  if (!result.success) throw new EnvironmentValidationError(result.error);
  return result.data;
}
