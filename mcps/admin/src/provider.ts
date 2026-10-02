import type { IdAdmin } from "@answerable/id-admin"
import { defineProvider, defineTool, type Mutation, type Tool, type UserPrincipal } from "@answerable/mcp"
import { z } from "zod"
import { accessWrites } from "./access"
import { createCalls } from "./calls"
import { requireFresh } from "./fresh"
import { organisationWrites } from "./organisations"
import { roleOf, roles, type Role, type Roles } from "./roles"
import { staffWrites } from "./staff"
import { toolboxWrites, type ToolboxAdmin } from "./toolbox"
import { createOrganisations, memberId, missingMember, missingOrganisation, organizationId, scopes, type Writes } from "./writes"

const time = z.iso.datetime()
const status = z.enum(["active", "disabled"])
const page = {
  limit: z.number().int().min(1).max(100).default(20).describe("Items per page, 1 to 100; default 20"),
  cursor: z.uuid().optional().describe("next_cursor from the previous page; omit it for the first page"),
}
const paged = <Item extends z.ZodObject>(item: Item) => z.object({ items: z.array(item), next_cursor: z.uuid().nullable(), has_more: z.boolean() })

// What each tool returns is ID's own answer, with ID's field names; the output schemas keep the fields named here and drop the rest.
const organisation = z.object({
  id: z.uuid(), slug: z.string(), name: z.string(), status, logo: z.string().nullable(), metadata: z.string().nullable().describe("JSON text, or null"),
  disabledAt: time.nullable(), createdAt: time, updatedAt: time,
})
const member = z.object({
  id: z.uuid().describe("The member id: the person's membership of this organisation"), userId: z.uuid(), email: z.string(), name: z.string(),
  status: z.enum(["inert", "active", "disabled"]), membershipStatus: z.enum(["active", "revoked"]), effective: z.boolean().describe("Whether the membership is in force now"),
})
const via = z.object({ entitlementId: z.uuid(), principal: z.enum(["organization", "group", "member"]), groupId: z.uuid().nullable() })
const target = z.object({
  kind: z.enum(["client", "resource", "client_resource"]), id: z.string().describe("The client id, or for kind resource the resource"),
  resource: z.string().optional().describe("For kind client_resource, the resource"), scopes: z.array(z.string()),
  via: z.array(via).describe("The entitlements that grant it: organisation-wide, a group's or the member's own"),
})

/** What `createAdminProvider` needs: ID's admin API, the roles, the platform organisation, the admin MCP's resource and the critical operations' rule. */
type AdminProviderConfig = {
  id: IdAdmin
  authority: Roles
  platform: string
  /** The admin MCP's resource URL, which role entitlements name. */
  resource: string
  /** ID's origin, whose `/security` page the freshness refusal names. */
  issuer: string
  /** How recent a directory sign-in a critical operation needs, in seconds: `ADMIN_FRESH_SECONDS`. */
  freshSeconds: number
  /** The Toolbox's admin API; without it `toolbox_enable` answers `PRECONDITION_FAILED`. */
  toolbox?: ToolboxAdmin
}

/** The tools of the admin MCP and the least role each needs, reading and writing ID's admin API as the admin MCP's machine client. */
export function createAdminProvider({ id, authority, platform, resource, issuer, freshSeconds, toolbox }: AdminProviderConfig) {
  // Each tool with the least role that may use it; null: any member of the platform organisation.
  const minimums = new Map<string, Role | null>()
  const role = <Definition extends Tool | Mutation>(minimum: Role | null, tool: Definition) => {
    minimums.set(tool.name, minimum)
    return tool
  }
  const calls = createCalls(id)
  const { read, need, list, all } = calls

  const whoami = role(null, defineTool({
    name: "admin.whoami", title: "Who am I",
    description: "Read who you are to the Answerable admin MCP: your user, membership, organisation and host client, your staff role as Answerable ID says it on this call (team, admin or owner; null, with how to get one, when you hold none) and the tools that role lets you use. Call it first, and when a tool you expect is missing. Changes nothing.",
    scopes, input: z.object({}),
    output: z.object({
      userId: z.uuid(), membershipId: z.uuid(), organizationId: z.uuid().describe("The platform organisation"), clientId: z.string().describe("The OAuth client of the host you are using"),
      role: z.enum(roles).nullable().describe("team reads; admin also makes ordinary changes; owner also runs the critical operations; null: none"),
      nextStep: z.string().nullable().describe("How to get a role, when you hold none"),
      tools: z.array(z.string()).describe("The tools you may call, by the names hosts list"),
    }),
    async execute(_input, { principal }) {
      const held = await authority.role(principal)
      const refusals = await Promise.all(provider.tools.map(tool => authority.refusal(principal, tool.scopes, minimum(tool))))
      const usable = provider.tools.filter((_, index) => !refusals[index])
      return {
        userId: principal.userId, membershipId: principal.membershipId, organizationId: principal.organizationId, clientId: principal.clientId, role: held,
        nextStep: held ? null : "Ask an owner to add you to a group that holds answerable-team, answerable-admin or answerable-owner on the admin MCP's resource; your next call then has the role.",
        // The commit tools come with the first mutation a role may prepare.
        tools: [...usable.map(tool => tool.name.replace(".", "_")), ...(usable.some(tool => tool.kind === "mutate") ? ["admin_commit", "admin_commit_confirmed"] : [])],
      }
    },
  }))

  const organisationsList = role("team", defineTool({
    name: "organisations.list",
    description: "List the organisations in Answerable ID, newest first, 20 per page by default and at most 100: id, slug, name and status. Filter by q, text in the name or slug, and by status. When has_more is true, pass next_cursor as cursor for the next page. Changes nothing; organisations_get reads one organisation's domains and SSO provider.",
    scopes,
    input: z.object({ q: z.string().trim().min(1).max(100).optional().describe("Text to find in the name or slug, in any case"), status: status.optional(), ...page }),
    output: paged(organisation.pick({ id: true, slug: true, name: true, status: true, createdAt: true })),
    execute: (input, context) => list("/organizations", input, context),
  }))

  const organisationsGet = role("team", defineTool({
    name: "organisations.get",
    description: "Read one organisation from Answerable ID: its slug, name, status, logo and metadata, every email domain routed to it, and its SSO provider: issuer, domain, whether it signs in through Answerable's platform application or its own credentials, and whether a client secret is set. sso is null when it has none. Changes nothing.",
    scopes,
    input: z.object({ organizationId }),
    output: organisation.extend({
      domains: z.array(z.object({ id: z.uuid(), domain: z.string(), status })).describe("Every email domain routed to the organisation"),
      sso: z.object({
        issuer: z.string(), domain: z.string(),
        oidc: z.object({ credentials: z.enum(["platform", "own"]).describe("platform: Answerable's Google or Microsoft application; own: the organisation's"), hasClientSecret: z.boolean() }),
      }).nullable(),
    }),
    async execute({ organizationId }, context) {
      const path = `/organizations/${organizationId}`
      const row = await need<z.input<typeof organisation>>(path, context, missingOrganisation(organizationId))
      const domains = await all<{ id: string; domain: string; status: "active" | "disabled" }>(`${path}/domains`, context, missingOrganisation(organizationId))
      const sso = await read<{ issuer: string; domain: string; oidc: { credentials: "platform" | "own"; hasClientSecret: boolean } }>(`${path}/sso-provider`, context)
      return { ...row, domains, sso: sso ?? null }
    },
  }))

  const membersList = role("team", defineTool({
    name: "members.list",
    description: "List the members of an organisation, newest first, 20 per page by default and at most 100: member id, user id, email, name, status and whether the membership is in force now. A person becomes a member at their first sign-in. Filter by exact email, by q, text in the email or name, and by effective. When has_more is true, pass next_cursor as cursor. Changes nothing.",
    scopes,
    input: z.object({
      organizationId, email: z.email().optional().describe("Exactly this email address"), q: z.string().trim().min(1).max(100).optional().describe("Text to find in the email or name"),
      effective: z.boolean().optional().describe("Only members whose membership is, or is not, in force now"), ...page,
    }),
    output: paged(member),
    execute: ({ organizationId, ...params }, context) => list(`/organizations/${organizationId}/members`, params, context, missingOrganisation(organizationId)),
  }))

  const memberDetail = member.extend({
    validFrom: time.nullable(), validUntil: time.nullable(), createdAt: time,
    groups: z.array(z.object({ groupId: z.uuid(), slug: z.string(), name: z.string(), validFrom: time.nullable(), validUntil: time.nullable() })),
    access: z.array(target).describe("What the member's entitlements reach, from ID's member access view"),
  })
  const membersGet = role("team", defineTool({
    name: "members.get",
    description: "Read one member of an organisation: their user, email, name, status and validity window, the groups they belong to, and their access: each client and resource their entitlements reach, with the scopes and the entitlements (organisation-wide, a group's or their own) that grant them. memberId is the id from members_list. Changes nothing.",
    scopes,
    input: z.object({ organizationId, memberId }),
    output: memberDetail,
    async execute({ organizationId, memberId }, context) {
      const path = `/organizations/${organizationId}/members/${memberId}`
      const missing = missingMember(organizationId, memberId)
      const [row, access] = await Promise.all([
        need<Omit<z.input<typeof memberDetail>, "access">>(path, context, missing), need<{ targets: z.input<typeof target>[] }>(`${path}/access`, context, missing),
      ])
      return { ...row, access: access.targets }
    },
  }))

  const groupsList = role("team", defineTool({
    name: "groups.list",
    description: "List the groups of an organisation, newest first, 20 per page by default and at most 100: id, slug, name, status and external id. Filter by q, text in the name or slug, and by status. When has_more is true, pass next_cursor as cursor. Changes nothing; members_get shows the groups of one member.",
    scopes,
    input: z.object({ organizationId, q: z.string().trim().min(1).max(100).optional().describe("Text to find in the name or slug"), status: status.optional(), ...page }),
    output: paged(z.object({ id: z.uuid(), slug: z.string(), name: z.string(), status, externalId: z.string().nullable() })),
    execute: ({ organizationId, ...params }, context) => list(`/organizations/${organizationId}/groups`, params, context, missingOrganisation(organizationId)),
  }))

  const accessList = role("team", defineTool({
    name: "access.list",
    description: "List the entitlements of an organisation, newest first, 20 per page by default and at most 100. Each names who holds it (memberId, else groupId, else the whole organisation), the client and resource it reaches, its scopes, status and validity window. A row with a clientId reaches its resource through that client only: toolbox_enable makes one per host client, carrying toolbox, beside the grants for people. Filter by clientId, resource, memberId, groupId and status. When has_more is true, pass next_cursor as cursor. Changes nothing.",
    scopes,
    input: z.object({
      organizationId, clientId: z.string().min(1).optional().describe("Only entitlements for this OAuth client"), resource: z.url().optional().describe("Only entitlements for this resource URL"),
      memberId: z.uuid().optional().describe("Only this member's own entitlements"), groupId: z.uuid().optional().describe("Only this group's entitlements"), status: status.optional(), ...page,
    }),
    output: paged(z.object({
      id: z.uuid(), memberId: z.uuid().nullable(), groupId: z.uuid().nullable(), clientId: z.string().nullable(), resource: z.string().nullable(),
      scopes: z.array(z.string()), status, validFrom: time.nullable(), validUntil: time.nullable(),
    })),
    execute: ({ organizationId, ...params }, context) => list(`/organizations/${organizationId}/entitlements`, params, context, missingOrganisation(organizationId)),
  }))

  const auditList = role("team", defineTool({
    name: "audit.list",
    description: "List Answerable ID's audit events, newest first, 20 per page by default and at most 100, across every organisation or one. requestId is the x-request-id of the call that caused the event: for a change made through the admin MCP, the execution id in its evidence. operationId is ID's operation; filter by it to follow one change. from is inclusive, to exclusive. When has_more is true, pass next_cursor as cursor. Changes nothing.",
    scopes,
    input: z.object({
      organizationId: organizationId.optional().describe("Only events of this organisation; omit for every organisation"), action: z.string().min(1).optional().describe("Exactly this action, such as organization.created"),
      actorId: z.string().min(1).optional().describe("Only events by this user id or client id"), operationId: z.uuid().optional().describe("Only the events of this ID operation"),
      outcome: z.enum(["success", "failure", "denied"]).optional(), targetType: z.string().min(1).optional().describe("Only events on this kind of target, such as organization"),
      targetId: z.string().min(1).optional().describe("Only events on this target"), from: time.optional().describe("From this time, inclusive, in UTC"), to: time.optional().describe("Before this time, in UTC"), ...page,
    }),
    output: paged(z.object({
      id: z.uuid(), occurredAt: time, action: z.string(), outcome: z.enum(["success", "failure", "denied"]), actorType: z.enum(["user", "client", "system"]), actorId: z.string(),
      organizationId: z.uuid().nullable(), targetType: z.string(), targetId: z.string().nullable(), reason: z.string().nullable(),
      requestId: z.string().nullable().describe("The x-request-id of the call that caused it"), operationId: z.uuid().nullable().describe("ID's operation, null for an event outside one"),
    })),
    execute: (input, context) => list("/audit-events", input, context),
  }))

  const ssoTest = role("team", defineTool({
    name: "sso.test",
    description: "Run Answerable ID's connectivity test of an organisation's SSO provider: whether its discovery document and signing keys can be fetched and whether the issuer matches, with each problem found. ID refuses an issuer over plain HTTP, such as a local test directory. Changes nothing; organisations_get shows which provider is set.",
    scopes,
    input: z.object({ organizationId }),
    output: z.object({
      issuer: z.string(), kind: z.enum(["entra", "google", "oidc"]),
      discovery: z.object({
        url: z.string(), reachable: z.boolean(), status: z.number().int().nullable(), issuerMatches: z.boolean().nullable(),
        authorizationEndpoint: z.string().nullable(), tokenEndpoint: z.string().nullable(), jwksUri: z.string().nullable(),
      }),
      jwks: z.object({ reachable: z.boolean(), keys: z.number().int().nullable().describe("How many signing keys it publishes") }),
      elapsedMs: z.number(),
      problems: z.array(z.object({ code: z.string(), detail: z.string() })).describe("Empty when the provider passed"),
    }),
    execute: ({ organizationId }, context) => need(`/organizations/${organizationId}/sso-provider/test`, context,
      `Organisation ${organizationId} has no SSO provider in Answerable ID, or does not exist; organisations_get shows its SSO provider`),
  }))

  const staffList = role("team", defineTool({
    name: "staff.list",
    description: "List the members of the Answerable platform organisation who can reach this admin MCP, newest first, 20 per page by default and at most 100, each with their staff role (team, admin or owner, or null when they hold none), read from Answerable ID whatever their groups are called. When has_more is true, pass next_cursor as cursor. Changes nothing.",
    scopes,
    input: z.object(page),
    output: paged(z.object({ memberId: z.uuid(), userId: z.uuid(), email: z.string(), name: z.string(), role: z.enum(roles).nullable() })),
    async execute(params, context) {
      const answer = await list<{ memberId: string; userId: string; email: string; name: string; scopes: string[] }>(`/organizations/${platform}/access`, { resource, ...params }, context,
        `Answerable ID does not know this admin MCP's resource, ${resource}; register it`)
      return { ...answer, items: answer.items.map(item => ({ ...item, role: roleOf(item.scopes) })) }
    },
  }))

  const fresh = (principal: UserPrincipal) => requireFresh(principal, { maxAge: freshSeconds, issuer })
  const writes: Writes = { calls, role, platform, resource, fresh, ...createOrganisations({ calls, authority, platform, fresh }) }
  const provider = defineProvider({
    id: "admin", version: "2026-10-01",
    tools: [
      whoami, organisationsList, organisationsGet, membersList, membersGet, groupsList, accessList, auditList, ssoTest, staffList,
      ...organisationWrites(writes), ...accessWrites(writes), ...toolboxWrites(writes, toolbox), ...staffWrites(writes),
    ],
  })
  /** The least role a tool needs; null: any member of the platform organisation. */
  const minimum = (tool: { name: string }) => minimums.get(tool.name)!
  return { provider, minimum }
}
