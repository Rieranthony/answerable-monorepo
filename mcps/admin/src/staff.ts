import { defineMutation, type ToolContext } from "@answerable/mcp"
import { z } from "zod"
import { confers, grantString, roleOf, roles } from "./roles"
import { commitWith, errors, noPrecondition, precondition, scopes, target, type Assignment, type Entitlement, type Group, type Member, type Writes } from "./writes"

type Via = { entitlementId: string; principal: "organization" | "group" | "member"; groupId: string | null }
const rank = (scopes: string[]) => roles.indexOf(roleOf(scopes)!)
const input = z.object({
  memberId: z.uuid().describe("The member's id in the platform organisation, from staff_list"),
  role: z.enum(roles).describe("team reads; admin also makes ordinary changes; owner also runs the critical operations"),
})

/**
 * The critical writes on who is staff: a role is held through a group of the platform organisation whose entitlement on the admin MCP's resource
 * carries the role's grant string. The groups are found by that entitlement, never by their slug.
 */
export function staffWrites({ calls, role, platform, resource, fresh }: Writes) {
  const at = encodeURIComponent(resource)
  // The member, and what their access view says they hold on the admin MCP's resource, and through which entitlements.
  async function staff(memberId: string, context: ToolContext) {
    const member = await calls.need<Member>(`/organizations/${platform}/members/${memberId}`, context,
      `The platform organisation has no member ${memberId}; staff_list lists its members`)
    const view = await calls.read<{ targets: { kind: string; id: string; scopes: string[]; via: Via[] }[] }>(`/organizations/${platform}/members/${memberId}/access`, context)
    const held = view?.targets.filter(confers(resource)) ?? []
    return { member, scopes: held.flatMap(item => item.scopes), via: held.flatMap(item => item.via) }
  }
  // The platform organisation's role entitlements: on the admin MCP's resource, active, for every client.
  async function roleEntitlements(context: ToolContext) {
    return (await calls.all<Entitlement>(`/organizations/${platform}/entitlements?resource=${at}`, context)).filter(item => item.status === "active" && item.clientId === null)
  }
  const group = (groupId: string, context: ToolContext) =>
    calls.need<Group>(`/organizations/${platform}/groups/${groupId}`, context, `The platform organisation has no group ${groupId}`)

  const staffGrant = role("owner", defineMutation({
    name: "staff.grant", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare giving a member of the Answerable platform organisation a staff role on this admin MCP, by adding them to a group whose entitlement carries the role. Owner only, with a recent sign-in at your directory. ${commitWith} It applies to their next request.`,
    input,
    output: z.object({ memberId: z.uuid(), groupId: z.uuid(), role: z.enum(roles), operationId: z.uuid() }),
    async prepare({ memberId, role: granted }, context) {
      fresh(context.principal)
      const { member, scopes: held } = await staff(memberId, context)
      if (!member.effective) throw precondition(`${member.email}'s membership of the platform organisation is not in force`, { memberId })
      if (held.includes(grantString(granted))) throw precondition(`${member.email} already holds ${granted}`, { memberId, role: granted })
      const candidates = (await roleEntitlements(context)).filter(item => item.groupId !== null && item.memberId === null && item.scopes.includes(grantString(granted)))
      const groups = (await Promise.all(candidates.map(async item => ({ entitlement: item, group: await group(item.groupId!, context) }))))
        .filter(({ group }) => group.status === "active")
        // The group that confers the least beyond the role, then the oldest.
        .sort((a, b) => rank(a.entitlement.scopes) - rank(b.entitlement.scopes) || (a.group.id < b.group.id ? -1 : 1))
      if (!groups.length) {
        throw precondition(`No group of the platform organisation holds ${grantString(granted)} on ${resource}. Create one: groups_create in the platform organisation (${platform}), then access_grant to that group on ${resource} with the scope ${grantString(granted)}`, {
          role: granted, grantString: grantString(granted), resource,
        })
      }
      const [{ entitlement, group: joined }] = groups as [(typeof groups)[number]]
      const { etag } = await calls.versioned<Entitlement>(`/organizations/${platform}/entitlements/${entitlement.id}`, context, `The platform organisation has no entitlement ${entitlement.id}`)
      const before = roleOf(held)
      const after = roleOf([...held, ...entitlement.scopes])
      return {
        targets: [target("entitlement", entitlement.id, `${entitlement.scopes.join(" ")} of group “${joined.name}”`, etag)],
        preview: {
          summary: `Make ${member.email} ${granted} of the admin MCP: add them to group “${joined.name}” of the platform organisation`,
          changes: [{ path: `staff[${memberId}].role`, from: before, to: after }, { path: `groups[${joined.id}].members[${memberId}]`, from: null, to: { validFrom: null, validUntil: null } }],
          effects: ["permission_change" as const],
        },
        plan: { memberId, role: granted, groupId: joined.id },
      }
    },
    // The membership must still be absent: ID refuses the write with 412 if it appeared meanwhile.
    async commit({ intent_id, plan: { memberId, role: granted, groupId }, preview }, context) {
      const done = await calls.write("PUT", `/organizations/${platform}/groups/${groupId}/members/${memberId}`, { body: {}, ifNoneMatch: "*", key: intent_id }, context)
      return { results: { memberId, groupId, role: granted, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  const staffRevoke = role("owner", defineMutation({
    name: "staff.revoke", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare taking a staff role on this admin MCP away from a member of the Answerable platform organisation, by removing them from every group whose entitlement carries the role. Owner only, with a recent sign-in at your directory. ${commitWith} It applies to their next request.`,
    input,
    output: z.object({ memberId: z.uuid(), groupIds: z.array(z.uuid()), operationIds: z.array(z.uuid()) }),
    async prepare({ memberId, role: revoked }, context) {
      fresh(context.principal)
      const { member, scopes: held, via } = await staff(memberId, context)
      if (!held.includes(grantString(revoked))) throw precondition(`${member.email} does not hold ${revoked}`, { memberId, role: revoked })
      const entitlements = new Map((await roleEntitlements(context)).map(item => [item.id, item]))
      const conferring = via.filter(item => entitlements.get(item.entitlementId)?.scopes.includes(grantString(revoked)))
      const leaving = [...new Set(conferring.flatMap(item => (item.principal === "group" && item.groupId ? [item.groupId] : [])))].sort()
      if (!leaving.length) {
        const [first] = conferring
        throw precondition(`${member.email} holds ${revoked} through ${first?.principal === "member" ? "their own" : "an organisation-wide"} entitlement${first ? ` ${first.entitlementId}` : ""}, not a group; revoke that with access_revoke`, {
          memberId, role: revoked, entitlementId: first?.entitlementId ?? null,
        })
      }
      const rows = await Promise.all(leaving.map(async groupId => ({
        group: await group(groupId, context),
        row: await calls.versioned<Assignment>(`/organizations/${platform}/groups/${groupId}/members/${memberId}`, context, `${member.email} is not in group ${groupId}`),
      })))
      const remaining = via.filter(item => !(item.principal === "group" && leaving.includes(item.groupId!))).flatMap(item => entitlements.get(item.entitlementId)?.scopes ?? [])
      const after = roleOf(remaining)
      const warnings = [noPrecondition("removing a member from a group")]
      if (remaining.includes(grantString(revoked))) warnings.unshift(`${member.email} still holds ${revoked} through an entitlement that is not a group's; access_revoke removes it.`)
      if (member.userId === context.principal.userId) warnings.unshift("You are removing your own role: your next request has only the role that remains.")
      if (revoked === "owner" && after !== "owner") {
        const owners = (await calls.all<{ memberId: string; scopes: string[] }>(`/organizations/${platform}/access?resource=${at}`, context)).filter(item => item.memberId !== memberId && roleOf(item.scopes) === "owner")
        if (!owners.length) warnings.unshift("No other owner remains: only Answerable ID's admin API, with root or a platform administrator's token, can make an owner again.")
      }
      if (rows.length > 1) warnings.push("Not atomic: the member leaves each group in turn; if one removal fails, the ones before it stay done.")
      return {
        targets: rows.map(({ group: left, row }) => target("group_member", row.body.id, `${member.email} in “${left.name}”`, row.etag)),
        preview: {
          summary: `Take ${revoked} away from ${member.email}: remove them from group ${rows.map(({ group: left }) => `“${left.name}”`).join(", ")} of the platform organisation`,
          changes: [
            { path: `staff[${memberId}].role`, from: roleOf(held), to: after },
            ...rows.map(({ group: left, row }) => ({ path: `groups[${left.id}].members[${memberId}]`, from: { validFrom: row.body.validFrom, validUntil: row.body.validUntil }, to: null })),
          ],
          effects: ["permission_change" as const],
          warnings,
        },
        plan: { memberId, groupIds: leaving },
      }
    },
    // One removal per group, each keyed by the intent's id and its step.
    async commit({ intent_id, plan: { memberId, groupIds }, preview }, context) {
      const operationIds: string[] = []
      for (const [step, groupId] of groupIds.entries()) {
        const done = await calls.write("DELETE", `/organizations/${platform}/groups/${groupId}/members/${memberId}`, { key: `${intent_id}.${step + 1}` }, context)
        operationIds.push(done.operationId)
      }
      return { results: { memberId, groupIds, operationIds }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  return [staffGrant, staffRevoke]
}
