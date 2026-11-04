import { afterAll, afterEach, expect, setSystemTime, spyOn, test } from "bun:test"
import { errorOf, type TestMcp } from "@answerable/mcp/testing"
import { createAdmin, type FakeId } from "./test/admin"
import { serving } from "./test/database"

// The five tools that stop someone, against the fake ID and the admin MCP's roles: each is previewed, committed under the intent's key with a
// platform:users token, and refused for the wrong role, a staff target and an unknown person; those that let someone back in, for an old sign-in too.
const login = await serving()
afterAll(() => login.drop())
const admins: Awaited<ReturnType<typeof createAdmin>>[] = []
afterEach(async () => {
  setSystemTime()
  await Promise.all(admins.splice(0).map(admin => admin.mcp.close()))
})
async function admin(options?: Parameters<typeof createAdmin>[1]) {
  const created = await createAdmin(login.db, options)
  admins.push(created)
  return created
}

type Client = Awaited<ReturnType<TestMcp["connect"]>>
type Prepared = {
  intent_id: string; commit_token: string
  targets: { resource_type: string; resource_id: string; label: string; version: { kind: string; value: string } }[]
  preview: { summary: string; changes: { path: string; from: unknown; to: unknown }[]; effects: string[]; warnings: string[]; quantities: unknown[] }
}
const call = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
const refusal = async (client: Client, name: string, args: Record<string, unknown>) => {
  const answer = await call(client, name, args)
  if (!answer.isError) throw new Error(`${name} succeeded where a refusal was expected: ${JSON.stringify(answer.structuredContent)}`)
  return errorOf(answer)
}
const prepared = async (client: Client, name: string, args: Record<string, unknown>) => {
  const answer = await call(client, name, args)
  if (answer.isError) throw new Error(`${name}: ${JSON.stringify(errorOf(answer))}`)
  return answer.structuredContent as Prepared
}
const confirm = (client: Client, intent: Prepared) => call(client, "admin_commit_confirmed", { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary })
const committed = async (client: Client, intent: Prepared) => {
  const answer = await confirm(client, intent)
  if (answer.isError) throw new Error(`commit: ${JSON.stringify(errorOf(answer))}`)
  return answer.structuredContent as { results: Record<string, unknown>; applied_changes: unknown[]; effects_performed: string[] }
}
const names = async (client: Client) => (await client.listTools()).tools.map(tool => tool.name)
const writes = (id: FakeId) => id.received.filter(({ request }) => !request.startsWith("GET"))
const noPrecondition = (write: string) => `Answerable ID takes no precondition on ${write}: the admin MCP reads the target again just before it writes, but a change in between is not refused by ID.`
const outlives = "A service token already issued lives to its expiry, and each app's own session is the app's to end."

// Two client organisations, and Ada, one person who is a member of both; Grace is in the first alone.
function people(id: FakeId) {
  const newco = id.organisation(Bun.randomUUIDv7(), { name: "Newco", slug: "newco" })
  const bare = id.organisation(Bun.randomUUIDv7(), { name: "Bare", slug: "bare" })
  const ada = id.member(newco.id, { email: "ada@newco.example", name: "Ada Lovelace" })
  const adaAtBare = id.member(bare.id, { email: "ada@newco.example", name: "Ada Lovelace", userId: ada.userId })
  const grace = id.member(newco.id, { email: "grace@newco.example", name: "Grace Hopper" })
  const user = (member: { userId: unknown }) => id.userOf(String(member.userId))!
  return { newco, bare, ada, adaAtBare, grace, user }
}

test("users_disable names the person and every organisation it reaches, commits one disable under the intent's key with a platform:users token, and users_enable reverses the status", async () => {
  const { id, staff } = await admin()
  const { ada, user } = people(id)
  user(ada).sessionCount = 2
  const client = await staff(["admin", "answerable-admin"]).connect()
  const intent = await prepared(client, "users_disable", { email: "ada@newco.example" })
  expect(id.received.filter(({ request }) => request.startsWith("GET /api/admin/v1/users")).map(({ request }) => request)).toEqual([
    "GET /api/admin/v1/users?email=ada%40newco.example&limit=1", `GET /api/admin/v1/users/${ada.userId}`,
  ])
  expect(intent).toMatchObject({ policy_class: "controlled", commit_tool: "admin_commit_confirmed" })
  expect(intent.targets).toEqual([{ resource_type: "user", resource_id: String(ada.userId), label: "ada@newco.example", version: { kind: "timestamp", value: String(user(ada).updatedAt) } }])
  expect(intent.preview).toEqual({
    summary: expect.stringMatching(/^Disable ada@newco\.example \(Ada Lovelace\) in Answerable ID at every organisation they belong to: (newco, bare|bare, newco)$/),
    changes: [{ path: `users[${ada.userId}].status`, from: "active", to: "disabled" }],
    effects: ["cascade_delete"],
    warnings: [
      expect.stringMatching(/^Reaches every organisation, not one: (newco, bare|bare, newco)\. Answerable ID ends their 2 sessions, revokes their grants and stored tokens, and refuses their sign-in at each organisation\.$/),
      outlives, "users_enable restores the status, not the revoked sessions, grants or tokens: the person signs in again.", noPrecondition("disabling a user"),
    ],
    quantities: [],
  })
  expect(writes(id)).toEqual([])
  const receipt = await committed(client, intent)
  expect(receipt.results).toEqual({ userId: ada.userId, status: "disabled", operationId: expect.any(String) })
  expect(receipt.effects_performed).toEqual(["cascade_delete"])
  expect(writes(id)).toEqual([{ request: `POST /api/admin/v1/users/${ada.userId}/disable`, requestId: expect.any(String), idempotencyKey: intent.intent_id, ifMatch: null, ifNoneMatch: null, caller: "admin-mcp" }])
  // The fake refuses a token without platform:users, so the write could only have been made with the machine client's users token.
  expect(id.scopesAsked).toEqual(["platform:read", "platform:read platform:users"])
  expect(user(ada)).toMatchObject({ status: "disabled", sessionCount: 0 })
  expect(await refusal(client, "users_disable", { email: "ada@newco.example" })).toMatchObject({
    code: "PRECONDITION_FAILED", message: "ada@newco.example is already disabled", retry: { policy: "after_state_change" }, details: { preconditions: [{ userId: ada.userId, status: "disabled" }] },
  })
  const enable = await prepared(client, "users_enable", { email: "ada@newco.example" })
  expect(enable.preview).toEqual({
    summary: expect.stringMatching(/^Enable ada@newco\.example \(Ada Lovelace\) in Answerable ID, so that they can sign in again at the organisations where their membership is in force: (newco, bare|bare, newco)$/),
    changes: [{ path: `users[${ada.userId}].status`, from: "disabled", to: "active" }],
    effects: [],
    warnings: ["Revoked sessions, grants and tokens are not restored: the person signs in again.", noPrecondition("enabling a user")],
    quantities: [],
  })
  expect((await committed(client, enable)).results).toEqual({ userId: ada.userId, status: "active", operationId: expect.any(String) })
  expect(writes(id).map(({ request }) => request)).toEqual([`POST /api/admin/v1/users/${ada.userId}/disable`, `POST /api/admin/v1/users/${ada.userId}/enable`])
  expect(user(ada).status).toBe("active")
  expect(await refusal(client, "users_enable", { email: "ada@newco.example" })).toMatchObject({ code: "PRECONDITION_FAILED", message: "ada@newco.example is already enabled" })
})

test("a person who is in no organisation is named as such, and enabling names a membership that is not in force", async () => {
  const { id, staff } = await admin()
  const { ada, adaAtBare, user } = people(id)
  const client = await staff(["admin", "answerable-admin"]).connect()
  const nowhere = id.user({ email: "nowhere@example.test", name: "No One", status: "disabled" })
  const alone = await prepared(client, "users_enable", { email: String(nowhere.email) })
  expect(alone.preview.summary).toBe("Enable nowhere@example.test (No One) in Answerable ID, so that they can sign in again at the organisations where their membership is in force: no organisation")
  expect(alone.preview.warnings).toEqual(["Revoked sessions, grants and tokens are not restored: the person signs in again.", noPrecondition("enabling a user")])
  user(ada).status = "disabled"
  adaAtBare.effective = false
  const enable = await prepared(client, "users_enable", { email: "ada@newco.example" })
  expect(enable.preview.summary).toMatch(/: (newco, bare \(not in force\)|bare \(not in force\), newco)$/)
  expect(enable.preview.warnings[1]).toBe("Not in force, and not changed by this: bare. members_reinstate brings back a membership that was removed.")
})

test("a person is named by their address, required and alone: an id is no way to name them, and an address ID does not hold is NOT_FOUND", async () => {
  const { id, staff } = await admin()
  const { newco, ada } = people(id)
  const client = await staff(["admin", "answerable-owner"]).connect()
  for (const name of ["users_disable", "users_enable", "users_retireemail"]) {
    expect(await refusal(client, name, {}), name).toMatchObject({ code: "INVALID_INPUT", retry: { policy: "after_fix_input" } })
    expect((await refusal(client, name, { userId: String(ada.userId) })).code, name).toBe("INVALID_INPUT")
    expect((await refusal(client, name, { email: "ada@newco.example", userId: String(ada.userId) })).code, name).toBe("INVALID_INPUT")
    expect(await refusal(client, name, { email: "nobody@newco.example" }), name).toMatchObject({
      code: "NOT_FOUND", retry: { policy: "never" },
      message: "Answerable ID has no user with the address nobody@newco.example. An address retired with users_retireemail finds nobody",
    })
    expect((await refusal(client, name, { email: "not an address" })).code, name).toBe("INVALID_INPUT")
  }
  for (const name of ["members_remove", "members_reinstate"]) {
    expect((await refusal(client, name, { organizationId: newco.id })).code, name).toBe("INVALID_INPUT")
    expect((await refusal(client, name, { organizationId: newco.id, memberId: String(ada.id) })).code, name).toBe("INVALID_INPUT")
    expect((await refusal(client, name, { organizationId: newco.id, email: "ada@newco.example", memberId: String(ada.id) })).code, name).toBe("INVALID_INPUT")
    expect(await refusal(client, name, { organizationId: newco.id, email: "nobody@newco.example" }), name).toMatchObject({
      code: "NOT_FOUND", message: `Organisation ${newco.id} has no member with the address nobody@newco.example; members_list lists them`,
    })
    const unknown = crypto.randomUUID()
    expect(await refusal(client, name, { organizationId: unknown, email: "ada@newco.example" }), name).toMatchObject({ code: "NOT_FOUND", message: `Answerable ID has no organisation ${unknown}; organisations_list lists them` })
  }
  expect(writes(id)).toEqual([])
})

test("users_retireemail is an owner's terminal write: it refuses a person who is not disabled, and previews that the next holder is a new person; the address then finds nobody, for any tool", async () => {
  const { id, staff } = await admin()
  const { ada, user } = people(id)
  const owner = await staff(["admin", "answerable-owner"]).connect()
  expect(await refusal(owner, "users_retireemail", { email: "ada@newco.example" })).toMatchObject({
    code: "PRECONDITION_FAILED", retry: { policy: "after_state_change" }, details: { preconditions: [{ userId: ada.userId, status: "active" }] },
    message: "ada@newco.example is not disabled: prepare users_disable and commit it first, because Answerable ID retires the address of a disabled person only",
  })
  await committed(owner, await prepared(owner, "users_disable", { email: "ada@newco.example" }))
  const intent = await prepared(owner, "users_retireemail", { email: "ada@newco.example" })
  expect(intent.targets).toEqual([{ resource_type: "user", resource_id: String(ada.userId), label: "ada@newco.example", version: { kind: "timestamp", value: String(user(ada).updatedAt) } }])
  expect(intent.preview).toEqual({
    summary: "Retire the address ada@newco.example of Ada Lovelace, for good, so that another person can hold it",
    changes: [
      { path: `users[${ada.userId}].email`, from: "ada@newco.example", to: "a tombstone address" },
      { path: `users[${ada.userId}].retiredEmail`, from: null, to: "ada@newco.example" },
    ],
    effects: [],
    warnings: [
      "Permanent: nothing gives the address back to this person, and the address then finds nobody, so no tool can name them.",
      "The next holder of the address is a new person with a new sub: nothing of this person's carries over to them.",
      noPrecondition("retiring an address"),
    ],
    quantities: [],
  })
  const receipt = await committed(owner, intent)
  expect(receipt.results).toEqual({ userId: ada.userId, operationId: expect.any(String) })
  expect(writes(id).map(({ request, idempotencyKey }) => [request, idempotencyKey])).toEqual([
    [`POST /api/admin/v1/users/${ada.userId}/disable`, expect.any(String)], [`POST /api/admin/v1/users/${ada.userId}/retire-email`, intent.intent_id],
  ])
  expect(user(ada)).toMatchObject({ retiredEmail: "ada@newco.example", email: `${ada.userId}@retired.invalid` })
  for (const name of ["users_disable", "users_enable", "users_retireemail"]) {
    expect(await refusal(owner, name, { email: "ada@newco.example" }), name).toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("An address retired with users_retireemail finds nobody") })
  }
  // The tombstone members_list shows is still their address in ID, which refuses to enable it.
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    const tombstone = `${ada.userId}@retired.invalid`
    expect(errorOf(await confirm(owner, await prepared(owner, "users_enable", { email: tombstone })))).toMatchObject({
      code: "UPSTREAM_REJECTED", message: expect.stringContaining("user_email_retired"), details: { upstream: { status: 409, code: "user_email_retired" } },
    })
    expect(await refusal(owner, "users_disable", { email: tombstone })).toMatchObject({ code: "PRECONDITION_FAILED", message: `${tombstone} is already disabled` })
  } finally { log.mockRestore() }
})

test("members_remove revokes one membership and says the other organisations stay; members_reinstate brings it back, not the grants, and says when the person is disabled everywhere", async () => {
  const { id, staff } = await admin()
  const { newco, bare, ada, adaAtBare, user } = people(id)
  const group = id.group(newco.id, { slug: "engineers", name: "Engineers" })
  id.join(group.id, ada.id)
  const client = await staff(["admin", "answerable-admin"]).connect()
  const remove = await prepared(client, "members_remove", { organizationId: newco.id, email: "ada@newco.example" })
  expect(id.received.map(({ request }) => request).filter(request => request.includes("/members?"))).toEqual([`GET /api/admin/v1/organizations/${newco.id}/members?email=ada%40newco.example&limit=1`])
  expect(remove.targets).toEqual([{ resource_type: "member", resource_id: ada.id, label: "ada@newco.example", version: { kind: "etag", value: `"${ada.id}:1"` } }])
  expect(remove.preview).toEqual({
    summary: "Remove ada@newco.example (Ada Lovelace) from organisation “Newco” (newco)",
    changes: [{ path: `organizations[${newco.id}].members[${ada.id}].membershipStatus`, from: "active", to: "revoked" }],
    effects: ["permission_change"],
    warnings: [
      "Reaches this organisation only: ada@newco.example stays a member of bare. users_disable stops them everywhere.", outlives,
      "members_reinstate restores the membership, not the direct grants and group assignments removed with it.", noPrecondition("removing a member"),
    ],
    quantities: [],
  })
  expect(writes(id)).toEqual([])
  const receipt = await committed(client, remove)
  expect(receipt.results).toEqual({ organizationId: newco.id, memberId: ada.id, operationId: expect.any(String) })
  expect(receipt.effects_performed).toEqual(["permission_change"])
  expect(writes(id)).toEqual([{
    request: `DELETE /api/admin/v1/organizations/${newco.id}/members/${ada.id}`, requestId: expect.any(String), idempotencyKey: remove.intent_id, ifMatch: null, ifNoneMatch: null, caller: "admin-mcp",
  }])
  expect(id.scopesAsked).toEqual(["platform:read", "platform:read platform:users"])
  expect(ada).toMatchObject({ membershipStatus: "revoked", effective: false })
  expect(adaAtBare).toMatchObject({ membershipStatus: "active", effective: true })
  expect(id.joined(group.id, ada.id)).toBe(false)
  expect(await refusal(client, "members_remove", { organizationId: newco.id, email: "ada@newco.example" })).toMatchObject({
    code: "PRECONDITION_FAILED", message: "ada@newco.example is already removed from organisation “Newco” (newco)", details: { preconditions: [{ memberId: ada.id, membershipStatus: "revoked" }] },
  })
  expect(await refusal(client, "members_reinstate", { organizationId: bare.id, email: "ada@newco.example" })).toMatchObject({
    code: "PRECONDITION_FAILED", message: "ada@newco.example is not removed from organisation “Bare” (bare): their membership is active",
  })
  const reinstate = await prepared(client, "members_reinstate", { organizationId: newco.id, email: "ada@newco.example" })
  expect(reinstate.targets).toEqual([expect.objectContaining({ resource_type: "member", resource_id: ada.id, version: { kind: "etag", value: `"${ada.id}:2"` } })])
  expect(reinstate.preview).toEqual({
    summary: "Reinstate ada@newco.example (Ada Lovelace) in organisation “Newco” (newco)",
    changes: [{ path: `organizations[${newco.id}].members[${ada.id}].membershipStatus`, from: "revoked", to: "active" }],
    effects: ["permission_change"],
    warnings: [
      "Reaches this organisation only. Direct grants and group assignments removed with the membership are not restored: grant them again with access_grant and groups_addmember.",
      noPrecondition("reinstating a member"),
    ],
    quantities: [],
  })
  expect((await committed(client, reinstate)).results).toEqual({ organizationId: newco.id, memberId: ada.id, operationId: expect.any(String) })
  expect(writes(id).at(-1)).toMatchObject({ request: `POST /api/admin/v1/organizations/${newco.id}/members/${ada.id}/reinstate`, idempotencyKey: reinstate.intent_id })
  expect(ada).toMatchObject({ membershipStatus: "active", effective: true })
  expect(id.joined(group.id, ada.id)).toBe(false)
  // A person who is disabled everywhere is not signed in by a reinstated membership; an only membership reads as no other organisation.
  await committed(client, await prepared(client, "users_disable", { email: "ada@newco.example" }))
  await committed(client, await prepared(client, "members_remove", { organizationId: bare.id, email: "ada@newco.example" }))
  const again = await prepared(client, "members_reinstate", { organizationId: bare.id, email: "ada@newco.example" })
  expect(again.preview.warnings).toEqual([
    expect.stringContaining("Reaches this organisation only."), "ada@newco.example is disabled at every organisation, so reinstating the membership does not let them sign in: users_enable does.", noPrecondition("reinstating a member"),
  ])
  expect(user(ada).status).toBe("disabled")
  id.member(bare.id, { email: "solo@bare.example", name: "Solo" })
  expect((await prepared(client, "members_remove", { organizationId: bare.id, email: "solo@bare.example" })).preview.warnings[0]).toBe(
    "Reaches this organisation only: solo@bare.example stays a member of no other organisation. users_disable stops them everywhere.",
  )
})

test("a team member sees none of the five, an admin the four that are not terminal, an owner all five", async () => {
  const { staff } = await admin()
  const stopping = async (client: Client) => (await names(client)).filter(name => ["users_disable", "users_enable", "users_retireemail", "members_remove", "members_reinstate"].includes(name))
  expect(await stopping(await staff(["admin", "answerable-team"]).connect())).toEqual([])
  const operator = await staff(["admin", "answerable-admin"]).connect()
  expect(await stopping(operator)).toEqual(["users_disable", "users_enable", "members_remove", "members_reinstate"])
  await expect(call(operator, "users_retireemail", { email: "a@b.example" })).rejects.toThrow("Tool users_retireemail not found")
  expect(await stopping(await staff(["admin", "answerable-owner"]).connect())).toEqual(["users_disable", "users_enable", "users_retireemail", "members_remove", "members_reinstate"])
})

test("acting on someone who is Answerable staff needs the owner role, for each of the five, though four need only admin: an admin is PERMISSION_DENIED and nothing is written; an owner may, and a person who is not staff is an admin's", async () => {
  const { id, staff, platform } = await admin()
  const { newco, bare } = people(id)
  // Two members of staff, who are members of client organisations too (the address is the same everywhere): one active, one disabled.
  const boss = id.member(platform, { email: "boss@answerable.test", name: "The Boss" })
  const bossAtNewco = id.member(newco.id, { email: "boss@answerable.test", name: "The Boss", userId: boss.userId })
  const gone = id.member(platform, { email: "gone@answerable.test", name: "Gone", status: "disabled" })
  const goneAtBare = id.member(bare.id, { email: "gone@answerable.test", name: "Gone", userId: gone.userId, status: "disabled", membershipStatus: "revoked", effective: false })
  const left = id.member(platform, { email: "left@answerable.test", name: "Left", status: "disabled" })
  const aimed: [string, Record<string, unknown>][] = [
    ["users_disable", { email: "boss@answerable.test" }],
    ["users_enable", { email: "gone@answerable.test" }],
    ["members_remove", { organizationId: newco.id, email: "boss@answerable.test" }],
    ["members_reinstate", { organizationId: bare.id, email: "gone@answerable.test" }],
  ]
  const operator = await staff(["admin", "answerable-admin"]).connect()
  for (const [name, args] of aimed) {
    const staffer = name === "users_disable" || name === "members_remove" ? "boss" : "gone"
    expect(await refusal(operator, name, args), name).toMatchObject({
      code: "PERMISSION_DENIED", retry: { policy: "never" },
      message: `${staffer}@answerable.test is Answerable staff, and acting on staff is an owner's critical operation: staff.revoke is owner only, so an admin could otherwise cut off an owner`,
    })
  }
  // The terminal tool is not listed to an admin at all.
  await expect(call(operator, "users_retireemail", { email: "left@answerable.test" })).rejects.toThrow("Tool users_retireemail not found")
  expect(writes(id)).toEqual([])
  // Someone who is not staff is an admin's.
  for (const [name, args] of [["users_disable", { email: "ada@newco.example" }], ["members_remove", { organizationId: newco.id, email: "ada@newco.example" }]] as const) {
    expect((await prepared(operator, name, args)).targets, name).toHaveLength(1)
  }
  // An owner prepares and commits each of the five on staff.
  const owner = await staff(["admin", "answerable-owner"]).connect()
  for (const [name, args] of [...aimed, ["users_retireemail", { email: "left@answerable.test" }] as const]) {
    const intent = await prepared(owner, name, args)
    expect(intent.targets, name).toHaveLength(1)
    await committed(owner, intent)
  }
  expect(writes(id).map(({ request }) => request.replace(/\/[0-9a-f-]{36}/g, "/id"))).toEqual([
    "POST /api/admin/v1/users/id/disable", "POST /api/admin/v1/users/id/enable", "DELETE /api/admin/v1/organizations/id/members/id",
    "POST /api/admin/v1/organizations/id/members/id/reinstate", "POST /api/admin/v1/users/id/retire-email",
  ])
  expect([id.userOf(String(boss.userId))!.status, bossAtNewco.membershipStatus, goneAtBare.membershipStatus, id.userOf(String(left.userId))!.retiredEmail]).toEqual(["disabled", "revoked", "active", "left@answerable.test"])
})

test("disabling a member of staff warns that it also ends their access and that ID refuses it for the last platform administrator; a person disabling or removing themselves is warned", async () => {
  const { id, staff, platform } = await admin()
  const boss = id.member(platform, { email: "boss@answerable.test", name: "The Boss" })
  const self = staff(["admin", "answerable-owner"])
  const client = await self.connect()
  const other = await prepared(client, "users_disable", { email: String(boss.email) })
  expect(other.preview.warnings).toContain("The Boss is Answerable staff: this also ends their access to the admin MCP, and Answerable ID refuses it for the last platform administrator.")
  expect(other.preview.warnings.some(warning => warning.startsWith("You are"))).toBe(false)
  const disabling = await prepared(client, "users_disable", { email: String(self.member.email) })
  expect(disabling.preview.warnings).toContain("You are disabling yourself: your sessions end with it, and only another admin can enable you again.")
  const removing = await prepared(client, "members_remove", { organizationId: platform, email: String(self.member.email) })
  expect(removing.preview.warnings).toContain("You are removing yourself from this organisation.")
})

test("the other self warnings: enabling, reinstating and retiring one's own account or membership", async () => {
  const { id, staff, platform } = await admin()
  const self = staff(["admin", "answerable-owner"])
  const client = await self.connect()
  const user = id.userOf(String(self.member.userId))!
  user.status = "disabled"
  expect((await prepared(client, "users_enable", { email: String(self.member.email) })).preview.warnings).toContain("You are enabling yourself.")
  expect((await prepared(client, "users_retireemail", { email: String(self.member.email) })).preview.warnings).toContain("You are retiring your own address.")
  self.member.membershipStatus = "revoked"
  expect((await prepared(client, "members_reinstate", { organizationId: platform, email: String(self.member.email) })).preview.warnings).toContain("You are reinstating yourself.")
})

test("what lets someone back in or frees an address needs a directory sign-in within the window: an old or no sign-in answers ADMIN_REAUTHENTICATION_REQUIRED at prepare, and an intent prepared in time cannot commit once the window has passed", async () => {
  const { id, staff } = await admin({ freshSeconds: 60 })
  const { newco, grace } = people(id)
  id.userOf(String(grace.userId))!.status = "disabled"
  const removed = id.member(newco.id, { email: "removed@newco.example", membershipStatus: "revoked", effective: false })
  const owner = staff(["admin", "answerable-owner"])
  const client = await owner.connect()
  const all: [string, Record<string, unknown>][] = [
    ["users_enable", { email: "grace@newco.example" }],
    ["users_retireemail", { email: "grace@newco.example" }],
    ["members_reinstate", { organizationId: newco.id, email: String(removed.email) }],
  ]
  const now = Math.floor(Date.now() / 1000)
  for (const time of [now - 120, null]) {
    owner.signedInAt(time)
    for (const [name, args] of all) {
      expect(await refusal(client, name, args), `${name} signed in at ${time}`).toMatchObject({
        code: "ADMIN_REAUTHENTICATION_REQUIRED", retry: { policy: "after_state_change" }, details: { upstream_auth_time: time, max_age_seconds: 60 },
      })
    }
  }
  owner.signedInAt(now)
  const intents: Prepared[] = []
  for (const [name, args] of all) intents.push(await prepared(client, name, args))
  setSystemTime(Date.now() + 61_000)
  for (const intent of intents) expect(errorOf(await confirm(client, intent)), intent.preview.summary).toMatchObject({ code: "ADMIN_REAUTHENTICATION_REQUIRED" })
  expect(writes(id)).toEqual([])
})

test("stopping one named person never waits for a sign-in: with an old or no sign-in, an admin prepares and commits users_disable and members_remove, and an owner users_disable on a member of staff", async () => {
  const { id, staff, platform } = await admin({ freshSeconds: 60 })
  const { newco, ada, grace, user } = people(id)
  const boss = id.member(platform, { email: "boss@answerable.test", name: "The Boss" })
  const operator = staff(["admin", "answerable-admin"])
  const client = await operator.connect()
  const old = Math.floor(Date.now() / 1000) - 120
  operator.signedInAt(old)
  await committed(client, await prepared(client, "users_disable", { email: "ada@newco.example" }))
  operator.signedInAt(null)
  await committed(client, await prepared(client, "members_remove", { organizationId: newco.id, email: "grace@newco.example" }))
  expect(user(ada).status).toBe("disabled")
  expect(grace.membershipStatus).toBe("revoked")
  const owner = staff(["admin", "answerable-owner"])
  const ownerClient = await owner.connect()
  owner.signedInAt(old)
  await committed(ownerClient, await prepared(ownerClient, "users_disable", { email: "boss@answerable.test" }))
  expect(user(boss).status).toBe("disabled")
  // The platform organisation's own membership stays behind the guard: its writes all need the sign-in, and users_disable is what stops a member of staff at once.
  expect((await refusal(ownerClient, "members_remove", { organizationId: platform, email: "boss@answerable.test" })).code).toBe("ADMIN_REAUTHENTICATION_REQUIRED")
})

test("a user or a member changed between prepare and commit is INTENT_STALE with the versions: the user by when ID last changed them, the member by ETag", async () => {
  const { id, staff } = await admin()
  const { newco, ada, grace, user } = people(id)
  const client = await staff(["admin", "answerable-admin"]).connect()
  const disable = await prepared(client, "users_disable", { email: "ada@newco.example" })
  const [before] = disable.targets
  id.revise(String(ada.userId))
  expect(errorOf(await confirm(client, disable))).toMatchObject({
    code: "INTENT_STALE", retry: { policy: "after_reprepare" },
    details: { targets: [{ resource_id: ada.userId, expected: before!.version.value, current: user(ada).updatedAt }] },
  })
  const remove = await prepared(client, "members_remove", { organizationId: newco.id, email: "grace@newco.example" })
  id.revise(String(grace.id))
  expect(errorOf(await confirm(client, remove))).toMatchObject({
    code: "INTENT_STALE", details: { targets: [{ resource_id: grace.id, expected: `"${grace.id}:1"`, current: `"${grace.id}:2"` }] },
  })
  expect(writes(id)).toEqual([])
  // Prepared again, both commit.
  await committed(client, await prepared(client, "users_disable", { email: "ada@newco.example" }))
  await committed(client, await prepared(client, "members_remove", { organizationId: newco.id, email: "grace@newco.example" }))
})

test("ID refusing a stop is the upstream refusal with its code, and a repeated commit answers the stored receipt without a second write", async () => {
  const { id, staff } = await admin()
  const { ada, grace } = people(id)
  const client = await staff(["admin", "answerable-owner"]).connect()
  const intent = await prepared(client, "users_disable", { email: "ada@newco.example" })
  id.fail(`POST /users/${ada.userId}/disable`, 409, "last_platform_administrator")
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(errorOf(await confirm(client, intent))).toMatchObject({
      code: "UPSTREAM_REJECTED", retry: { policy: "never" }, message: expect.stringContaining("last_platform_administrator"), details: { upstream: { status: 409, code: "last_platform_administrator" } },
    })
  } finally { log.mockRestore() }
  const other = await prepared(client, "users_disable", { email: "grace@newco.example" })
  const first = await committed(client, other)
  const again = (await confirm(client, other)).structuredContent
  expect(again).toEqual({ ...first, idempotent_replay: true, receipt_id: expect.any(String), intent_id: other.intent_id, status: "committed", committed_by: expect.anything() })
  expect(writes(id).filter(({ request }) => request.includes(String(grace.userId)))).toHaveLength(1)
})

test("a deployment whose machine client has no capability for platform:users cannot write: the commit answers UPSTREAM_REJECTED, and the message names the capability to add", async () => {
  const { id, staff } = await admin({ users: false })
  const { newco } = people(id)
  const client = await staff(["admin", "answerable-owner"]).connect()
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    for (const [name, args] of [["users_disable", { email: "ada@newco.example" }], ["members_remove", { organizationId: newco.id, email: "grace@newco.example" }]] as const) {
      expect(errorOf(await confirm(client, await prepared(client, name, args))), name).toMatchObject({
        code: "UPSTREAM_REJECTED", retry: { policy: "never" },
        message: "Answerable ID refused the client credentials of admin-mcp (400); check the client id, the client secret and the client's platform:read and platform:users capability for the admin resource",
      })
    }
  } finally { log.mockRestore() }
  expect(writes(id)).toEqual([])
})
