import { adminApi, failure, findBySlug, platformOrganisation, RootLocked } from "./admin-api"

type Options = {
  /** Answerable ID's origin. */
  id: string
  /** ID's root secret: the only bearer before a person is a platform administrator. */
  rootSecret: string
  /** The staff members' emails: each has signed in once, which made them members of the platform organisation. The first also becomes the platform administrator. */
  emails: readonly string[]
  fetch?: typeof globalThis.fetch
  log?: (line: string) => void
  /** How long one call to ID may take before make-admin fails naming it. */
  timeoutMs?: number
}

/**
 * The last step of the first run (`onboard.mdx` § First run, step 5): every member named into the admin MCP's owner group,
 * `answerable-owner`, which register creates, and then the first named into `platform-admins`, which carries every platform
 * scope. The owner group comes first, and only one person joins `platform-admins`: once a person holds `platform:write`, ID
 * refuses the root secret, which is this command's only bearer. The others are owners, who can add themselves to
 * `platform-admins` in the admin MCP when they need ID's admin API. Every member is found before anything is written, so a
 * name that has not signed in changes nothing. Confirms with one more call that root is locked. Safe to run again until then;
 * afterwards it says root is locked. Each run sends keys of its own: ID keeps a key's receipt for ever, so a constant key would
 * replay the first run's answer and add nobody when break glass restores an administrator who left.
 */
export async function makeAdmin({ id, rootSecret, emails, fetch = globalThis.fetch, log = console.log, timeoutMs = 30_000 }: Options) {
  const call = adminApi({ id, token: rootSecret, fetch, timeoutMs, rootLocked: "ID refuses the root secret already (root_locked): a person is a platform administrator, so the first run is over. An owner adds more with staff_grant in the admin MCP (docs/admin, Give someone a role)" })
  const platform = await platformOrganisation(call)
  const named = emails.filter((email, index) => emails.findIndex(other => other.toLowerCase() === email.toLowerCase()) === index)
  const members: { id: string; email: string }[] = []
  const missing: string[] = []
  for (const email of named) {
    const path = `/organizations/${platform}/members?email=${encodeURIComponent(email)}`
    const listed = await call("GET", path)
    if (!listed.ok) throw failure("GET", path, listed)
    const member = (listed.body.items as { id: string; email: string }[]).find(item => item.email.toLowerCase() === email.toLowerCase())
    if (member) members.push({ id: member.id, email })
    else missing.push(email)
  }
  if (missing.length > 0 || members.length === 0) throw new Error(`No member of the platform organisation has the email ${missing.join(" or ")}: sign in once at ${id}/login, then run make-admin again`)

  const run = crypto.randomUUID()
  const steps = [
    ["answerable-owner", "the admin MCP's owner role", members],
    ["platform-admins", "every platform scope", members.slice(0, 1)],
  ] as const
  for (const [slug, what, joining] of steps) {
    const group = await findBySlug(call, `/organizations/${platform}/groups`, slug)
    if (!group) throw new Error(slug === "platform-admins" ? "The platform organisation has no platform-admins group: ID seeds it at its first start" : "The platform organisation has no answerable-owner group: run register first, which creates it")
    for (const member of joining) {
      const path = `/organizations/${platform}/groups/${group}/members/${member.id}`
      const put = await call("PUT", path, { key: `make-admin-${run}-${slug}-${member.id}`, ifNoneMatch: true, body: {} })
      if (put.status === 200 || put.status === 201) log(`${member.email} (member ${member.id}): added to ${slug}, ${what}`)
      else if (put.status === 412) log(`${member.email} (member ${member.id}): already in ${slug}`)
      else throw failure("PUT", path, put)
    }
  }
  const others = members.slice(1).map(member => member.email)
  if (others.length > 0) log(`${others.join(", ")}: owners, not in platform-admins. The root secret locks with its first member, so an owner adds them in the admin MCP (groups_addmember) if they need ID's admin API.`)

  const check = await call("GET", "/organizations?limit=1").catch((error: Error) => {
    if (error instanceof RootLocked) return undefined
    throw error
  })
  if (check === undefined) {
    log(`Root is locked now: ID refuses the root secret (403 root_locked), because a person holds platform:write.
register goes on as its own machine client, ops-register, which its first run minted. Anything else with
ID's admin API needs your own session or a staff token (apps/web/content/docs/id/onboard.mdx, Get a staff token).
Keep ROOT_ADMIN_SECRET in the GitHub environment, with ROOT_ADMIN_BREAK_GLASS unset: it is the break-glass.`)
    return { platform, members: members.map(member => member.id) }
  }
  if (!check.ok) throw failure("GET", "/organizations", check)
  throw new Error(`${members[0]!.email} is in platform-admins, but ID still accepts the root secret: is ROOT_ADMIN_BREAK_GLASS true in ID's environment? Unset it and deploy`)
}
