import { and, eq, or, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { isEffective } from "../db/queries/effective.ts";
import { matchingEntitlements } from "../db/queries/effective.ts";
import {
  members,
  groupMembers,
  groups,
  organizations,
  users,
  oauthClients,
  oauthResources,
  oauthClientResources,
  organizationCapabilities,
  entitlements,
} from "../db/schema/index.ts";
import { grantScopes, identityScopes } from "./grant-scopes.ts";
type Source = {
  id: string;
  revision: number;
  resource: string | null;
  scopes: string[];
  validFrom: string | null;
  validUntil: string | null;
};
type Capability = Source & { grantKind: string };
type Assignment = Source & {
  memberId: string | null;
  groupId: string | null;
  groupMembership: {
    id: string;
    revision: number;
    groupRevision: number;
    validFrom: string | null;
    validUntil: string | null;
  } | null;
};

/** SQL facts for an already tenant-scoped member/client/resource query.
 * One statement evaluates source windows, membership and endpoint configuration.
 */
export function memberPermissionFields(
  executor: Executor,
  includeClient = true,
) {
  const activeMember = and(
    isEffective(members),
    eq(users.status, "active"),
    sql`${users.deletedAt} is null`,
    eq(organizations.status, "active"),
    sql`${organizations.deletedAt} is null`,
  );
  const clientId = includeClient ? oauthClients.clientId : sql`null::text`;
  const loginEligible = includeClient
    ? and(
        activeMember,
        eq(oauthClients.disabled, false),
        sql`${oauthClients.deletedAt} is null`,
        sql`${oauthClients.grantTypes} @> ARRAY['authorization_code']::text[]`,
      )
    : sql`false`;
  const resourceEligible = and(
    eq(oauthResources.disabled, false),
    sql`${oauthResources.deletedAt} is null`,
    or(
      eq(oauthResources.classification, "platform_shared"),
      eq(oauthResources.organizationId, members.organizationId),
    ),
  );

  return {
    organization: {
      id: organizations.id,
      authorizationVersion: organizations.authorizationVersion,
    },
    userId: users.id,
    client: includeClient
      ? {
          id: oauthClients.id,
          clientId: oauthClients.clientId,
          revision: oauthClients.revision,
          authorizationVersion: oauthClients.authorizationVersion,
          scopeCeiling: oauthClients.scopes,
        }
      : sql<null>`null`,
    resource: {
      id: oauthResources.id,
      identifier: oauthResources.identifier,
      revision: oauthResources.revision,
      scopeCeiling: oauthResources.allowedScopes,
    },
    loginEligible: sql<boolean>`coalesce(${loginEligible}, false)`,
    // The capability constraint already restricts admin_session to the bound resource.
    adminEligible: sql<boolean>`coalesce(${and(activeMember, resourceEligible)}, false)`,
    eligible: sql<boolean>`coalesce(${and(loginEligible, resourceEligible, sql`exists(select 1 from ${oauthClientResources} where ${oauthClientResources.clientId} = ${clientId} and ${oauthClientResources.resourceId} = ${oauthResources.identifier} and ${oauthClientResources.deletedAt} is null)`)}, false)`,
    refreshEnabled: includeClient
      ? sql<boolean>`coalesce(${oauthClients.grantTypes} @> ARRAY['refresh_token']::text[], false)`
      : sql<boolean>`false`,
    membership: {
      id: members.id,
      revision: members.revision,
      validFrom: members.validFrom,
      validUntil: members.validUntil,
    },
    evaluatedAt: sql<string>`statement_timestamp()::text`,
    capabilities: sql<
      Capability[]
    >`(select coalesce(jsonb_agg(jsonb_build_object('id', ${organizationCapabilities.id},
              'revision', ${organizationCapabilities.revision},
              'resource', ${organizationCapabilities.resource},
              'grantKind', ${organizationCapabilities.grantKind},
              'scopes', ${organizationCapabilities.scopes},
              'validFrom', ${organizationCapabilities.validFrom},
              'validUntil', ${organizationCapabilities.validUntil})
            order by ${organizationCapabilities.id}),
              '[]'::jsonb)
            from ${organizationCapabilities}
            where ${organizationCapabilities.organizationId} = ${members.organizationId}
            and ${organizationCapabilities.clientId} is not distinct from ${clientId}
            and (${organizationCapabilities.resource} is null or ${organizationCapabilities.resource} = ${oauthResources.identifier})
            and ${isEffective(organizationCapabilities)})`,
    assignments: sql<
      Assignment[]
    >`(select coalesce(jsonb_agg(jsonb_build_object('id', ${entitlements.id},
              'revision', ${entitlements.revision},
              'resource', ${entitlements.resource},
              'scopes', ${entitlements.scopes},
              'validFrom', ${entitlements.validFrom},
              'validUntil', ${entitlements.validUntil},
              'memberId', ${entitlements.memberId},
              'groupId', ${entitlements.groupId},
              'groupMembership', (select jsonb_build_object('id', ${groupMembers.id},
              'revision', ${groupMembers.revision},
              'groupRevision', ${groups.revision},
              'validFrom', ${groupMembers.validFrom},
              'validUntil', ${groupMembers.validUntil})
            from ${groupMembers}
            join ${groups} on ${groups.id} = ${groupMembers.groupId}
            where ${groupMembers.memberId} = ${members.id}
            and ${groupMembers.groupId} = ${entitlements.groupId}
            and ${isEffective(groupMembers)}
            and ${groups.status} = 'active'))
            order by ${entitlements.id}),
              '[]'::jsonb)
            from ${entitlements}
            where ${matchingEntitlements(executor)}
            and ${entitlements.clientId} is not distinct from ${clientId}
            and (${entitlements.resource} is null or ${entitlements.resource} = ${oauthResources.identifier}))`,
  };
}

type PermissionFacts = {
  organization: { id: string; authorizationVersion: number };
  userId: string;
  client: {
    id: string;
    clientId: string;
    revision: number;
    authorizationVersion: number;
    scopeCeiling: string[] | null;
  } | null;
  resource: {
    id: string;
    identifier: string;
    revision: number;
    scopeCeiling: string[] | null;
  } | null;
  loginEligible: boolean;
  adminEligible: boolean;
  eligible: boolean;
  refreshEnabled: boolean;
  membership: {
    id: string;
    revision: number;
    validFrom: Date | null;
    validUntil: Date | null;
  };
  evaluatedAt: string;
  capabilities: Capability[];
  assignments: Assignment[];
};

/** Internal evidence may contain unavailable target facts; public denials are projected below. */
function memberDecision(
  row: PermissionFacts,
  target: "client" | "resource" | "client_resource",
  grantType: "authorization_code" | "refresh_token" | "admin_session",
  requestedScopes?: string[],
) {
  return {
    allowed: false as const,
    grantType,
    subjectType: "user" as const,
    organization: row.organization,
    subject: { userId: row.userId, memberId: row.membership.id },
    client: target === "resource" ? null : row.client,
    resource: target === "client" ? null : row.resource,
    requestedScopes:
      requestedScopes === undefined
        ? null
        : [...new Set(requestedScopes)].sort(),
    scopes: [] as string[],
    evidence: {
      policyVersion: 1,
      evaluatedAt: row.evaluatedAt,
      membership: row.membership,
      capabilities: row.capabilities.filter(
        (source) => target !== "client" || source.resource === null,
      ),
      assignments: row.assignments.filter(
        (source) => target !== "client" || source.resource === null,
      ),
    },
  };
}

type MemberPermission =
  | ReturnType<typeof evaluateClientLoginPermission>
  | ReturnType<typeof evaluateAdminPermission>
  | ReturnType<typeof evaluateUserResourcePermission>;

/** Keep denied registration and source facts internal; expose only the coarse reason. */
export function memberPermissionView(decision: MemberPermission) {
  return decision.allowed
    ? decision
    : { allowed: false as const, reason: decision.reason };
}

/** Client login admission only; resource permission and native provenance are separate. */
export function evaluateClientLoginPermission(
  row: PermissionFacts,
  input?: {
    grantType: "authorization_code" | "refresh_token";
    requestedScopes: string[];
    originalScopes: string[];
  },
) {
  const grantType = input?.grantType ?? "authorization_code";
  const decision = memberDecision(
    row,
    "client",
    grantType,
    input?.requestedScopes,
  );
  if (!row.loginEligible) return { ...decision, reason: "context" as const };
  const capability = row.capabilities.find(
    (cap) => cap.resource === null && cap.grantKind === "authorization_code",
  );
  const assignments = row.assignments.filter(
    (source) => source.resource === null,
  );
  const renewal = row.capabilities.find(
    (cap) => cap.resource === null && cap.grantKind === "refresh_token",
  );
  if (grantType === "refresh_token" && (!row.refreshEnabled || !renewal))
    return { ...decision, reason: "capability" as const };
  const scopes = grantScopes(input?.requestedScopes, [
    row.client?.scopeCeiling ?? [],
    capability?.scopes ?? [],
    assignments.flatMap((source) => source.scopes),
    ...(input ? [input.originalScopes] : []),
    ...(grantType === "refresh_token" ? [renewal!.scopes] : []),
  ]);
  if (!scopes) return { ...decision, reason: "login" as const };
  return {
    ...decision,
    allowed: true as const,
    reason: "approved" as const,
    scopes,
    evidence: {
      policyVersion: 1,
      evaluatedAt: row.evaluatedAt,
      membership: row.membership,
      capabilities: [
        capability!,
        ...(grantType === "refresh_token" ? [renewal!] : []),
      ],
      assignments: assignments.filter((source) =>
        source.scopes.some((scope) => scopes.includes(scope)),
      ),
    },
  };
}

/** Resource-only assignments authorise direct sessions only at the bound admin resource. */
export function evaluateAdminPermission(row: PermissionFacts) {
  const decision = memberDecision(row, "resource", "admin_session");
  if (!row.adminEligible) return { ...decision, reason: "context" as const };
  const capability = row.capabilities.find(
    (cap) => cap.grantKind === "admin_session",
  );
  if (!capability) return { ...decision, reason: "capability" as const };
  const scopes = grantScopes(undefined, [
    row.resource?.scopeCeiling ?? [],
    capability.scopes,
    row.assignments.flatMap((source) => source.scopes),
  ]);
  if (!scopes) return { ...decision, reason: "scope" as const };
  return {
    ...decision,
    allowed: true as const,
    reason: "approved" as const,
    scopes,
    evidence: {
      policyVersion: 1,
      evaluatedAt: row.evaluatedAt,
      membership: row.membership,
      capabilities: [capability],
      assignments: row.assignments.filter((source) =>
        source.scopes.some((scope) => scopes.includes(scope)),
      ),
    },
  };
}

/** Permission is not authentication or consent. Native issuance separately verifies
 * the immutable grant context and passes its original scope ceiling.
 */
export function evaluateUserResourcePermission(
  row: PermissionFacts,
  input: {
    resource: string;
    grantType: "authorization_code" | "refresh_token";
    requestedScopes?: string[];
    originalScopes?: string[];
  },
) {
  const decision = memberDecision(
    row,
    "client_resource",
    input.grantType,
    input.requestedScopes,
  );
  if (
    !row.eligible ||
    (input.grantType === "refresh_token" && !row.refreshEnabled)
  )
    return { ...decision, reason: "context" as const };
  const originalScopes = input.originalScopes;
  if (
    originalScopes !== undefined &&
    input.requestedScopes?.some((scope) => !originalScopes.includes(scope))
  )
    return { ...decision, reason: "scope" as const };
  const login = evaluateClientLoginPermission(row);
  if (!login.allowed) return { ...decision, reason: login.reason };
  const pairCapability = row.capabilities.find(
    (cap) =>
      cap.resource === input.resource && cap.grantKind === "authorization_code",
  );
  const renewal = row.capabilities.find(
    (cap) =>
      cap.resource === input.resource && cap.grantKind === "refresh_token",
  );
  const pairAssignments = row.assignments.filter(
    (source) => source.resource === input.resource,
  );
  if (
    input.requestedScopes?.some(
      (scope) => identityScopes.has(scope) && !login.scopes.includes(scope),
    )
  )
    return { ...decision, reason: "login" as const };
  if (!pairCapability || (input.grantType === "refresh_token" && !renewal))
    return { ...decision, reason: "capability" as const };
  const ceilings = [
    row.client?.scopeCeiling ?? [],
    (row.resource?.scopeCeiling ?? []).filter(
      (scope) => !identityScopes.has(scope),
    ),
    pairCapability.scopes,
    pairAssignments.flatMap((source) => source.scopes),
    ...(input.originalScopes === undefined ? [] : [input.originalScopes]),
  ];
  if (input.grantType === "refresh_token") ceilings.push(renewal!.scopes);
  const scopes = grantScopes(
    input.requestedScopes?.filter((scope) => !identityScopes.has(scope)),
    ceilings,
  );
  if (!scopes) return { ...decision, reason: "scope" as const };
  return {
    ...decision,
    allowed: true as const,
    reason: "approved" as const,
    scopes,
    evidence: {
      policyVersion: 1,
      evaluatedAt: row.evaluatedAt,
      capabilities: [
        ...login.evidence.capabilities,
        pairCapability,
        ...(input.grantType === "refresh_token" ? [renewal!] : []),
      ],
      membership: row.membership,
      assignments: [
        ...login.evidence.assignments,
        ...pairAssignments.filter((source) =>
          source.scopes.some((scope) => scopes.includes(scope)),
        ),
      ],
    },
  };
}
