import { defineMutation, type ToolContext } from "@answerable/mcp"
import { z } from "zod"
import {
  commitWith, errors, invalid, memberId, missingMember, named, newKey, noPrecondition, organizationId, precondition, scopes, slug, target,
  type Assignment, type Entitlement, type Group, type Member, type Writes,
} from "./writes"

const groupId = z.uuid().describe("The group's id, from groups_list")
const sameTime = (a: string | null | undefined, b: string | null | undefined) => (a ? Date.parse(a) : null) === (b ? Date.parse(b) : null)
const sameScopes = (a: string[], b: string[]) => a.length === b.length && a.every(scope => b.includes(scope))

/** The writes on who may use what in an organisation: its groups, their members, and its entitlements. */
export function accessWrites(writes: Writes) {
  const { calls, role, organisation } = writes
  const missingGroup = (organizationId: string, id: string) => `Answerable ID has no group ${id} in organisation ${organizationId}; groups_list lists them`
  const group = (organizationId: string, id: string, context: ToolContext) =>
    calls.need<Group>(`/organizations/${organizationId}/groups/${id}`, context, missingGroup(organizationId, id))
  // A member whose membership is in force: ID refuses to assign access to a revoked one.
  async function member(organizationId: string, id: string, context: ToolContext) {
    const row = await calls.need<Member>(`/organizations/${organizationId}/members/${id}`, context, missingMember(organizationId, id))
    if (row.membershipStatus === "revoked") throw precondition(`${row.email}'s membership is revoked; Answerable ID gives it no access until it is reinstated`, { memberId: id })
    return row
  }
  const assignment = (organizationId: string, group: string, person: string, context: ToolContext) =>
    calls.version<Assignment>(`/organizations/${organizationId}/groups/${group}/members/${person}`, context)

  const groupsCreate = role("admin", defineMutation({
    name: "groups.create", risk: "normal", scopes, errors,
    description: `Prepare creating a group in an organisation in Answerable ID, with a slug unique in the organisation and a name. ${commitWith} Add members with groups_addmember and give the group access with access_grant.`,
    input: z.object({
      organizationId,
      slug: slug.describe("Unique in the organisation, such as engineers"),
      name: z.string().trim().min(1).max(200).describe("The group's name, 1 to 200 characters"),
    }),
    output: z.object({ groupId: z.uuid(), operationId: z.uuid() }),
    async prepare({ organizationId: id, slug, name }, context) {
      const { organisation: row, target: version } = await organisation(id, context)
      const taken = (await calls.all<Group>(`/organizations/${id}/groups?q=${slug}`, context)).find(item => item.slug === slug)
      if (taken) throw precondition(`Organisation ${named(row)} already has a group ${slug}, “${taken.name}”, ${taken.id}`, { slug, groupId: taken.id })
      return {
        targets: [version],
        preview: {
          summary: `Create group “${name}” (${slug}) in organisation ${named(row)}`,
          changes: [{ path: `organizations[${id}].groups[${slug}]`, from: null, to: { slug, name } }],
          warnings: [noPrecondition("creating a group")],
        },
        plan: { key: newKey(), slug, name },
      }
    },
    async commit({ targets: [version], plan: { key, slug, name }, preview }, context) {
      const done = await calls.write("POST", `/organizations/${version!.resource_id}/groups`, { body: { slug, name }, key }, context)
      return { results: { groupId: done.id, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: [] }
    },
  }))

  const groupsAddmember = role("admin", defineMutation({
    name: "groups.addmember", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare putting a member in a group of their organisation in Answerable ID, optionally until a time, or changing when their membership ends. ${commitWith} The member gains what the group's entitlements grant. A person is a member once they have signed in.`,
    input: z.object({ organizationId, groupId, memberId, validUntil: z.iso.datetime({ offset: true }).optional().describe("When the membership ends, ISO 8601; omit for no end") }),
    output: z.object({ groupId: z.uuid(), memberId: z.uuid(), operationId: z.uuid() }),
    async prepare({ organizationId: id, groupId: groupOf, memberId: person, validUntil }, context) {
      const { organisation: row } = await organisation(id, context)
      const joined = await group(id, groupOf, context)
      const who = await member(id, person, context)
      const current = await assignment(id, groupOf, person, context)
      const until = validUntil ?? null
      if (current && (validUntil === undefined || sameTime(current.body.validUntil, until))) {
        throw precondition(`${who.email} is already in group “${joined.name}”${current.body.validUntil ? ` until ${current.body.validUntil}` : ""}`, { groupId: groupOf, memberId: person })
      }
      const before = current ? { validFrom: current.body.validFrom, validUntil: current.body.validUntil } : null
      return {
        targets: current ? [target("group_member", current.body.id, `${who.email} in “${joined.name}”`, current.etag)] : [],
        preview: {
          summary: before
            ? `Change when ${who.email}'s membership of group “${joined.name}” in organisation ${named(row)} ends: ${before.validUntil ?? "never"} → ${until}`
            : `Add ${who.email} to group “${joined.name}” in organisation ${named(row)}${until ? ` until ${until}` : ""}`,
          changes: [{ path: `groups[${groupOf}].members[${person}]`, from: before, to: { validFrom: before?.validFrom ?? null, validUntil: until } }],
          effects: ["permission_change" as const],
        },
        plan: { key: newKey(), organizationId: id, groupId: groupOf, memberId: person, validUntil },
      }
    },
    // A change names the membership's version; a new membership asserts that there is none yet.
    async commit({ targets: [version], plan: { key, organizationId: id, groupId: groupOf, memberId: person, validUntil }, preview }, context) {
      const condition = version ? { ifMatch: version.version.value } : { ifNoneMatch: "*" as const }
      const done = await calls.write("PUT", `/organizations/${id}/groups/${groupOf}/members/${person}`, { body: validUntil ? { validUntil } : {}, ...condition, key }, context)
      return { results: { groupId: groupOf, memberId: person, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  const groupsDropmember = role("admin", defineMutation({
    name: "groups.dropmember", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare taking a member out of a group of their organisation in Answerable ID. ${commitWith} The member loses what the group's entitlements granted them, unless something else grants it.`,
    input: z.object({ organizationId, groupId, memberId }),
    output: z.object({ groupId: z.uuid(), memberId: z.uuid(), operationId: z.uuid() }),
    async prepare({ organizationId: id, groupId: groupOf, memberId: person }, context) {
      const { organisation: row } = await organisation(id, context)
      const joined = await group(id, groupOf, context)
      const who = await calls.need<Member>(`/organizations/${id}/members/${person}`, context, missingMember(id, person))
      const current = await assignment(id, groupOf, person, context)
      if (!current) throw precondition(`${who.email} is not in group “${joined.name}”`, { groupId: groupOf, memberId: person })
      return {
        targets: [target("group_member", current.body.id, `${who.email} in “${joined.name}”`, current.etag)],
        preview: {
          summary: `Remove ${who.email} from group “${joined.name}” in organisation ${named(row)}`,
          changes: [{ path: `groups[${groupOf}].members[${person}]`, from: { validFrom: current.body.validFrom, validUntil: current.body.validUntil }, to: null }],
          effects: ["permission_change" as const],
          warnings: [noPrecondition("removing a member from a group")],
        },
        plan: { key: newKey(), organizationId: id, groupId: groupOf, memberId: person },
      }
    },
    async commit({ plan: { key, organizationId: id, groupId: groupOf, memberId: person }, preview }, context) {
      const done = await calls.write("DELETE", `/organizations/${id}/groups/${groupOf}/members/${person}`, { key }, context)
      return { results: { groupId: groupOf, memberId: person, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  const kinds = ["organization", "group", "member"] as const
  const accessGrant = role("admin", defineMutation({
    name: "access.grant", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare granting scopes on a resource, such as the Toolbox's grant strings, to a whole organisation, one of its groups or one member in Answerable ID, optionally through one OAuth client only. ${commitWith} Every scope must be one the resource allows. ID keeps one entitlement per principal and target.`,
    input: z.object({
      organizationId,
      principal: z.strictObject({
        kind: z.enum(kinds).describe("organization: everyone in it; group: one group's members; member: one person"),
        id: z.uuid().optional().describe("The group's or the member's id; omit it for organization"),
      }).describe("Who receives it"),
      resource: z.url().describe("The resource it reaches, as registered in Answerable ID, such as the Toolbox's MCP URL"),
      clientId: z.string().min(1).max(200).optional().describe("Only through this OAuth client; omit it for every client"),
      scopes: z.array(z.string().min(1).max(300)).min(1).max(50).describe("The scopes or grant strings to grant, each allowed by the resource"),
    }),
    output: z.object({ entitlementId: z.uuid(), operationId: z.uuid() }),
    async prepare({ organizationId: id, principal, resource, clientId, scopes: asked }, context) {
      if (principal.kind === "organization" && principal.id !== undefined) throw invalid("principal.id", "Omit principal.id when the principal is the whole organization")
      if (principal.kind !== "organization" && principal.id === undefined) throw invalid("principal.id", `Name the ${principal.kind}'s id in principal.id`)
      const granted = [...new Set(asked)].sort()
      const { organisation: row, target: version } = await organisation(id, context)
      const registered = await calls.versioned<{ name: string; allowedScopes: string[] | null }>(`/resources/${encodeURIComponent(resource)}`, context,
        `Answerable ID has no resource ${resource}; register it first`)
      const allowed = registered.body.allowedScopes ?? []
      const outside = granted.filter(scope => !allowed.includes(scope))
      if (outside.length) throw invalid("scopes", `${resource} does not allow ${outside.join(", ")}; it allows ${allowed.length ? allowed.join(", ") : "no scope"}`)
      const who = principal.kind === "organization" ? `everyone in organisation ${named(row)}`
        : principal.kind === "group" ? `group “${(await group(id, principal.id!, context)).name}” in organisation ${named(row)}`
          : `${(await member(id, principal.id!, context)).email} in organisation ${named(row)}`
      if (clientId) await calls.need(`/clients/${encodeURIComponent(clientId)}`, context, `Answerable ID has no client ${clientId}`)
      const shape = { memberId: principal.kind === "member" ? principal.id! : null, groupId: principal.kind === "group" ? principal.id! : null, clientId: clientId ?? null, resource }
      const existing = (await calls.all<Entitlement>(`/organizations/${id}/entitlements?resource=${encodeURIComponent(resource)}`, context))
        .find(item => item.memberId === shape.memberId && item.groupId === shape.groupId && item.clientId === shape.clientId)
      if (existing?.status === "active" && sameScopes(existing.scopes, granted)) {
        throw precondition(`${who} already holds ${granted.join(" ")} on ${resource} through entitlement ${existing.id}`, { entitlementId: existing.id })
      }
      if (existing) {
        // A disabled row is enabled by a tool; only a change of scopes needs ID's admin API.
        const update = "its scopes with ID's updateEntitlement, as https://www.answerable.org/docs/id/admin-api/entitlements/updateEntitlement shows"
        const next = existing.status === "active" ? `Change ${update}`
          : `Enable it with access_enable and entitlementId ${existing.id}${sameScopes(existing.scopes, granted) ? "" : `, then change ${update}`}`
        throw precondition(`${who} has entitlement ${existing.id} on ${resource}, ${existing.status}, granting ${existing.scopes.join(" ")}; Answerable ID keeps one entitlement per principal and target. ${next}`, {
          entitlementId: existing.id, status: existing.status, scopes: existing.scopes,
        })
      }
      const through = clientId ? ` through ${clientId}` : ""
      return {
        targets: [version, target("resource", resource, registered.body.name, registered.etag)],
        preview: {
          summary: `Grant ${granted.join(" ")} on ${resource}${through} to ${who}`,
          changes: [{ path: `organizations[${id}].entitlements`, from: null, to: { ...shape, scopes: granted } }],
          effects: ["permission_change" as const],
          warnings: [noPrecondition("creating an entitlement")],
        },
        plan: { key: newKey(), body: { ...(shape.memberId ? { memberId: shape.memberId } : {}), ...(shape.groupId ? { groupId: shape.groupId } : {}), ...(clientId ? { clientId } : {}), resource, scopes: granted } },
      }
    },
    async commit({ targets: [version], plan: { key, body }, preview }, context) {
      const done = await calls.write("POST", `/organizations/${version!.resource_id}/entitlements`, { body, key }, context)
      return { results: { entitlementId: done.id, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  // Disabling and enabling an entitlement: the same target and check, opposite statuses.
  const revoking = { name: "access.revoke", verb: "Revoke", from: "from", write: "disabling an entitlement", path: "disable" } as const
  const enabling = { name: "access.enable", verb: "Grant again", from: "to", write: "enabling an entitlement", path: "enable" } as const
  const entitlementStatus = (to: "disabled" | "active") => {
    const words = to === "disabled" ? revoking : enabling
    return role("admin", defineMutation({
      name: words.name, risk: "normal", scopes, errors, effects: ["permission_change"],
      description: to === "disabled"
        ? `Prepare disabling an entitlement of an organisation in Answerable ID, so that it grants nothing; access_enable enables it again. ${commitWith} Deleting an entitlement is not possible through the admin MCP. Find the entitlement with access_list.`
        : `Prepare enabling a disabled entitlement of an organisation in Answerable ID, so that it grants its scopes again: the inverse of access_revoke. ${commitWith} Find the entitlement with access_list, status disabled.`,
      input: z.object({ organizationId, entitlementId: z.uuid().describe("The entitlement's id, from access_list") }),
      output: z.object({ entitlementId: z.uuid(), operationId: z.uuid() }),
      async prepare({ organizationId: id, entitlementId }, context) {
        const { organisation: row } = await organisation(id, context)
        const { body: held, etag } = await calls.versioned<Entitlement>(`/organizations/${id}/entitlements/${entitlementId}`, context,
          `Answerable ID has no entitlement ${entitlementId} in organisation ${id}; access_list lists them`)
        if (held.status === to) throw precondition(`Entitlement ${entitlementId} is already ${to}`, { entitlementId, status: held.status })
        const who = held.memberId ? (await calls.read<Member>(`/organizations/${id}/members/${held.memberId}`, context))?.email ?? `member ${held.memberId}`
          : held.groupId ? `group “${(await group(id, held.groupId, context)).name}”` : "everyone"
        const reach = [held.scopes.join(" "), ...(held.resource ? [`on ${held.resource}`] : []), ...(held.clientId ? [`through ${held.clientId}`] : [])].join(" ")
        return {
          targets: [target("entitlement", entitlementId, reach, etag)],
          preview: {
            summary: `${words.verb} ${reach} ${words.from} ${who} in organisation ${named(row)}`,
            changes: [{ path: `entitlements[${entitlementId}].status`, from: held.status, to }],
            effects: ["permission_change" as const],
            warnings: [
              ...(to === "disabled" ? ["A token already issued keeps its scopes until it expires; a server that reads access live, such as the Toolbox, drops it within its cache time."] : []),
              noPrecondition(words.write),
            ],
          },
          plan: { key: newKey(), organizationId: id },
        }
      },
      async commit({ targets: [version], plan: { key, organizationId: id }, preview }, context) {
        const done = await calls.write("POST", `/organizations/${id}/entitlements/${version!.resource_id}/${words.path}`, { key }, context)
        return { results: { entitlementId: version!.resource_id, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
      },
    }))
  }

  return [groupsCreate, groupsAddmember, groupsDropmember, accessGrant, entitlementStatus("disabled"), entitlementStatus("active")]
}
