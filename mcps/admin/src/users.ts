import { defineMutation, ToolError, type ToolContext } from "@answerable/mcp"
import { z } from "zod"
import {
  commitWith, errors, missingMember, missingOrganisation, named, noPrecondition, organizationId, precondition, scopes, target,
  type Member, type User, type Writes,
} from "./writes"

// A person is named by address or by id. Both are optional in the schema, because hosts refuse a top-level anyOf in a tool's input; `onlyOne` checks them.
const email = z.email().optional().describe("Their address as Answerable ID holds it, in any case; give this or the id, not both")

/** The one of `ids` and `email` the input gives; throws `INVALID_INPUT` naming both fields when it gives neither or both. */
function onlyOne<Id extends "userId" | "memberId">(input: Partial<Record<Id, string>> & { email?: string }, ids: Id, what: string) {
  const given = [input[ids], input.email].filter(value => value !== undefined)
  if (given.length === 1) return
  const message = given.length ? `Name the ${what} by email or by ${ids}, not both` : `Name the ${what}: give their email or their ${ids}`
  throw new ToolError("INVALID_INPUT", message, { details: { field_violations: ["email", ids].map(field => ({ field, message })) } })
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
// The organisations a user belongs to, as a preview names them; one whose membership is not in force says so.
const firms = (user: User) => (user.memberships.length ? user.memberships.map(item => (item.effective ? item.slug : `${item.slug} (not in force)`)).join(", ") : "no organisation")
// The address staff know a person by: a retired one keeps its original in `retiredEmail`, and `email` is a tombstone.
const addressOf = (user: User) => user.retiredEmail ?? user.email
// What a stopped person still has, which no write to ID reaches.
const outlives = "A service token already issued lives to its expiry, and each app's own session is the app's to end."

/**
 * The writes that stop someone, each naming the person by address or id: `users.disable`, `users.enable` and `users.retireemail` act on a user and so
 * on every organisation they belong to; `members.remove` and `members.reinstate` act on one membership. Each is previewed with the person and the
 * organisations it reaches. Acting on a member of the platform organisation needs the owner role, whatever the tool's own minimum. ID takes these commands
 * with `platform:users`, so each write names `scope: "users"`.
 */
export function userWrites({ calls, role, fresh, platform, organisation, protectStaff }: Writes) {
  async function userOf(input: { email?: string; userId?: string }, context: ToolContext) {
    onlyOne(input, "userId", "person")
    const id = input.userId ?? await userIdOf(input.email!, context)
    return calls.need<User>(`/users/${id}`, context, `Answerable ID has no user ${id}`)
  }
  async function userIdOf(address: string, context: ToolContext) {
    const [found] = (await calls.list<{ id: string }>("/users", { email: address, limit: 1 }, context)).items
    if (!found) throw new ToolError("NOT_FOUND", `Answerable ID has no user with the address ${address}. An address retired with users_retireemail finds nobody: name that person by userId`)
    return found.id
  }
  // A user has no ETag, so the version a target binds is when ID last changed the user.
  const userTarget = (user: User) => target("user", user.id, addressOf(user), user.updatedAt, "timestamp")
  const asSelf = (user: User, context: ToolContext) => user.id === context.principal.userId
  const staffNote = (user: User) => (user.memberships.some(item => item.organizationId === platform) ? [`${user.name} is Answerable staff: this also ends their access to the admin MCP, and Answerable ID refuses it for the last platform administrator.`] : [])

  const userOutput = z.object({ userId: z.uuid(), status: z.enum(["active", "disabled"]), operationId: z.uuid() })
  const person = { email, userId: z.uuid().optional().describe("Their user id, from members_list or staff_list; give this or the email, not both") }

  const disable = role("admin", defineMutation({
    name: "users.disable", risk: "normal", scopes, errors, effects: ["cascade_delete"],
    description: `Prepare disabling a person in Answerable ID at every organisation they belong to, not one: their sessions, grants and stored tokens end, and no sign-in works for them. Name them by email or userId. A person who is Answerable staff needs the owner role. ${commitWith} users_enable reverses the status, not what was revoked; members_remove stops them at one organisation only.`,
    input: z.object(person),
    output: userOutput,
    async prepare(input, context) {
      fresh(context.principal)
      const user = await userOf(input, context)
      await protectStaff(user, context)
      if (user.status === "disabled") throw precondition(`${addressOf(user)} is already disabled`, { userId: user.id, status: user.status })
      return {
        targets: [userTarget(user)],
        preview: {
          summary: `Disable ${user.email} (${user.name}) in Answerable ID at every organisation they belong to: ${firms(user)}`,
          changes: [{ path: `users[${user.id}].status`, from: user.status, to: "disabled" }],
          effects: ["cascade_delete" as const],
          warnings: [
            `Reaches every organisation, not one: ${firms(user)}. Answerable ID ends their ${plural(user.sessionCount, "session")}, revokes their grants and stored tokens, and refuses their sign-in at each organisation.`,
            outlives,
            "users_enable restores the status, not the revoked sessions, grants or tokens: the person signs in again.",
            ...staffNote(user),
            ...(asSelf(user, context) ? ["You are disabling yourself: your sessions end with it, and only another admin can enable you again."] : []),
            noPrecondition("disabling a user"),
          ],
        },
        plan: { userId: user.id },
      }
    },
    async commit({ intent_id, plan: { userId: id }, preview }, context) {
      const done = await calls.write("POST", `/users/${id}/disable`, { key: intent_id, scope: "users" }, context)
      return { results: { userId: id, status: "disabled" as const, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  const enable = role("admin", defineMutation({
    name: "users.enable", risk: "normal", scopes, errors,
    description: `Prepare enabling a disabled person in Answerable ID, so that they can sign in again where their membership is in force. Name them by email or userId. A person who is Answerable staff needs the owner role. ${commitWith} Sessions, grants and tokens revoked when they were disabled stay revoked, and a person whose address was retired cannot be enabled.`,
    input: z.object(person),
    output: userOutput,
    async prepare(input, context) {
      fresh(context.principal)
      const user = await userOf(input, context)
      await protectStaff(user, context)
      if (user.retiredEmail !== null) throw precondition(`${addressOf(user)}'s address was retired, which is permanent: ${user.name} cannot be enabled`, { userId: user.id, retired: true })
      if (user.status === "active") throw precondition(`${user.email} is already enabled`, { userId: user.id, status: user.status })
      const removed = user.memberships.filter(item => !item.effective).map(item => item.slug)
      return {
        targets: [userTarget(user)],
        preview: {
          summary: `Enable ${user.email} (${user.name}) in Answerable ID, so that they can sign in again at the organisations where their membership is in force: ${firms(user)}`,
          changes: [{ path: `users[${user.id}].status`, from: user.status, to: "active" }],
          warnings: [
            "Revoked sessions, grants and tokens are not restored: the person signs in again.",
            ...(removed.length ? [`Not in force, and not changed by this: ${removed.join(", ")}. members_reinstate brings back a membership that was removed.`] : []),
            ...(asSelf(user, context) ? ["You are enabling yourself."] : []),
            noPrecondition("enabling a user"),
          ],
        },
        plan: { userId: user.id },
      }
    },
    async commit({ intent_id, plan: { userId: id }, preview }, context) {
      const done = await calls.write("POST", `/users/${id}/enable`, { key: intent_id, scope: "users" }, context)
      return { results: { userId: id, status: "active" as const, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  // Terminal, so an owner's: the address is freed for another person.
  const retire = role("owner", defineMutation({
    name: "users.retireemail", risk: "normal", scopes, errors,
    description: `Prepare retiring the address of a disabled person in Answerable ID, for good, so that another person can hold it. Name them by email or userId; users_disable them first. Owner only, with a recent sign-in at your directory. ${commitWith} It cannot be undone: the next holder of the address is a new person with a new sub.`,
    input: z.object(person),
    output: z.object({ userId: z.uuid(), operationId: z.uuid() }),
    async prepare(input, context) {
      fresh(context.principal)
      const user = await userOf(input, context)
      await protectStaff(user, context)
      if (user.retiredEmail !== null) throw precondition(`${user.retiredEmail} is already retired: its address is free`, { userId: user.id, retired: true })
      if (user.status !== "disabled") throw precondition(`${user.email} is not disabled: prepare users_disable and commit it first, because Answerable ID retires the address of a disabled person only`, { userId: user.id, status: user.status })
      return {
        targets: [userTarget(user)],
        preview: {
          summary: `Retire the address ${user.email} of ${user.name}, for good, so that another person can hold it`,
          changes: [{ path: `users[${user.id}].email`, from: user.email, to: "a tombstone address" }, { path: `users[${user.id}].retiredEmail`, from: null, to: user.email }],
          warnings: [
            "Permanent: nothing gives the address back to this person, and users_enable refuses them afterwards.",
            "The next holder of the address is a new person with a new sub: nothing of this person's carries over to them.",
            ...(asSelf(user, context) ? ["You are retiring your own address."] : []),
            noPrecondition("retiring an address"),
          ],
        },
        plan: { userId: user.id },
      }
    },
    async commit({ intent_id, plan: { userId: id }, preview }, context) {
      const done = await calls.write("POST", `/users/${id}/retire-email`, { key: intent_id, scope: "users" }, context)
      return { results: { userId: id, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  async function memberOf(organizationId: string, input: { memberId?: string; email?: string }, context: ToolContext) {
    const id = input.memberId ?? await memberIdOf(organizationId, input.email!, context)
    return calls.versioned<Member>(`/organizations/${organizationId}/members/${id}`, context, missingMember(organizationId, id))
  }
  async function memberIdOf(organizationId: string, address: string, context: ToolContext) {
    const [found] = (await calls.list<{ id: string }>(`/organizations/${organizationId}/members`, { email: address, limit: 1 }, context, missingOrganisation(organizationId))).items
    if (!found) throw new ToolError("NOT_FOUND", `Organisation ${organizationId} has no member with the address ${address}; members_list lists them`)
    return found.id
  }
  // The member, with the person behind them for the staff check and the other organisations, and the organisation they are in.
  async function membership(organizationId: string, input: { memberId?: string; email?: string }, context: ToolContext) {
    onlyOne(input, "memberId", "member")
    const { organisation: row } = await organisation(organizationId, context)
    const { body: member, etag } = await memberOf(organizationId, input, context)
    const user = await calls.need<User>(`/users/${member.userId}`, context, `Answerable ID has no user ${member.userId}`)
    await protectStaff(user, context)
    return { row, member, user, version: target("member", member.id, member.email, etag) }
  }
  const memberPerson = { organizationId, memberId: z.uuid().optional().describe("The member's id, from members_list; give this or the email, not both"), email }
  const memberOutput = z.object({ organizationId: z.uuid(), memberId: z.uuid(), operationId: z.uuid() })

  const remove = role("admin", defineMutation({
    name: "members.remove", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare removing a person from one organisation in Answerable ID: their membership there is revoked, their direct grants and group assignments in it are removed, and they cannot sign in to it. Their other organisations stay as they are. Name the member by memberId or email. A person who is Answerable staff needs the owner role. ${commitWith} members_reinstate brings the membership back, not the grants and assignments; users_disable stops them everywhere.`,
    input: z.object(memberPerson),
    output: memberOutput,
    async prepare({ organizationId: id, ...input }, context) {
      fresh(context.principal)
      const { row, member, user, version } = await membership(id, input, context)
      if (member.membershipStatus === "revoked") throw precondition(`${member.email} is already removed from organisation ${named(row)}`, { memberId: member.id, membershipStatus: member.membershipStatus })
      const others = user.memberships.filter(item => item.organizationId !== id).map(item => item.slug)
      return {
        targets: [version],
        preview: {
          summary: `Remove ${member.email} (${member.name}) from organisation ${named(row)}`,
          changes: [{ path: `organizations[${id}].members[${member.id}].membershipStatus`, from: member.membershipStatus, to: "revoked" }],
          effects: ["permission_change" as const],
          warnings: [
            `Reaches this organisation only: ${member.email} stays a member of ${others.length ? others.join(", ") : "no other organisation"}. users_disable stops them everywhere.`,
            outlives,
            "members_reinstate restores the membership, not the direct grants and group assignments removed with it.",
            ...(asSelf(user, context) ? ["You are removing yourself from this organisation."] : []),
            noPrecondition("removing a member"),
          ],
        },
        plan: { organizationId: id, memberId: member.id },
      }
    },
    async commit({ intent_id, plan: { organizationId: id, memberId: person }, preview }, context) {
      const done = await calls.write("DELETE", `/organizations/${id}/members/${person}`, { key: intent_id, scope: "users" }, context)
      return { results: { organizationId: id, memberId: person, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  const reinstate = role("admin", defineMutation({
    name: "members.reinstate", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare reinstating a person removed from one organisation in Answerable ID, so that they can sign in to it again. Name the member by memberId or email. A person who is Answerable staff needs the owner role. ${commitWith} The direct grants and group assignments removed with the membership are not restored.`,
    input: z.object(memberPerson),
    output: memberOutput,
    async prepare({ organizationId: id, ...input }, context) {
      fresh(context.principal)
      const { row, member, user, version } = await membership(id, input, context)
      if (member.membershipStatus === "active") throw precondition(`${member.email} is not removed from organisation ${named(row)}: their membership is active`, { memberId: member.id, membershipStatus: member.membershipStatus })
      return {
        targets: [version],
        preview: {
          summary: `Reinstate ${member.email} (${member.name}) in organisation ${named(row)}`,
          changes: [{ path: `organizations[${id}].members[${member.id}].membershipStatus`, from: member.membershipStatus, to: "active" }],
          effects: ["permission_change" as const],
          warnings: [
            "Reaches this organisation only. Direct grants and group assignments removed with the membership are not restored: grant them again with access_grant and groups_addmember.",
            ...(member.status === "disabled" ? [`${member.email} is disabled at every organisation, so reinstating the membership does not let them sign in: users_enable does.`] : []),
            ...(asSelf(user, context) ? ["You are reinstating yourself."] : []),
            noPrecondition("reinstating a member"),
          ],
        },
        plan: { organizationId: id, memberId: member.id },
      }
    },
    async commit({ intent_id, plan: { organizationId: id, memberId: person }, preview }, context) {
      const done = await calls.write("POST", `/organizations/${id}/members/${person}/reinstate`, { key: intent_id, scope: "users" }, context)
      return { results: { organizationId: id, memberId: person, operationId: done.operationId }, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))

  return [disable, enable, retire, remove, reinstate]
}
