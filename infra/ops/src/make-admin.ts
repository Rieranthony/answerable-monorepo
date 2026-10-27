import { adminApi, failure, findBySlug, platformOrganisation, RootLocked } from "./admin-api"

type Options = {
  /** Answerable ID's origin. */
  id: string
  /** ID's root secret: the only bearer before a person is a platform administrator. */
  rootSecret: string
  /** The staff member's email: they have signed in once, which made them a member of the platform organisation. */
  email: string
  fetch?: typeof globalThis.fetch
  log?: (line: string) => void
  /** How long one call to ID may take before make-admin fails naming it. */
  timeoutMs?: number
}

/**
 * The last step of the first run (`onboard.mdx` § First run, step 5): the member with `email` into the admin MCP's owner
 * group, `answerable-owner`, which register creates, and then into `platform-admins`, which carries every platform scope.
 * The owner group comes first: once a person holds `platform:write`, ID refuses the root secret, which is this command's
 * only bearer. Confirms with one more call that it does. Safe to run again until then; afterwards it says root is locked.
 * Each run sends keys of its own: ID keeps a key's receipt for ever, so a constant key would replay the first run's
 * answer and add nobody when break glass restores an administrator who left.
 */
export async function makeAdmin({ id, rootSecret, email, fetch = globalThis.fetch, log = console.log, timeoutMs = 30_000 }: Options) {
  const call = adminApi({ id, token: rootSecret, fetch, timeoutMs, rootLocked: "ID refuses the root secret already (root_locked): a person is a platform administrator, so the first run is over. Add more staff with your own session (docs/id/onboard, The next staff member)" })
  const platform = await platformOrganisation(call)
  const members = `/organizations/${platform}/members?email=${encodeURIComponent(email)}`
  const listed = await call("GET", members)
  if (!listed.ok) throw failure("GET", members, listed)
  const member = (listed.body.items as { id: string; email: string }[]).find(item => item.email.toLowerCase() === email.toLowerCase())
  if (!member) throw new Error(`No member of the platform organisation has the email ${email}: sign in once at ${id}/login, then run make-admin again`)

  const run = crypto.randomUUID()
  for (const [slug, what] of [["answerable-owner", "the admin MCP's owner role"], ["platform-admins", "every platform scope"]] as const) {
    const group = await findBySlug(call, `/organizations/${platform}/groups`, slug)
    if (!group) throw new Error(slug === "platform-admins" ? "The platform organisation has no platform-admins group: ID seeds it at its first start" : "The platform organisation has no answerable-owner group: run register first, which creates it")
    const path = `/organizations/${platform}/groups/${group}/members/${member.id}`
    const put = await call("PUT", path, { key: `make-admin-${run}-${slug}`, ifNoneMatch: true, body: {} })
    if (put.status === 200 || put.status === 201) log(`${email} (member ${member.id}): added to ${slug}, ${what}`)
    else if (put.status === 412) log(`${email} (member ${member.id}): already in ${slug}`)
    else throw failure("PUT", path, put)
  }

  const check = await call("GET", "/organizations?limit=1").catch((error: Error) => {
    if (error instanceof RootLocked) return undefined
    throw error
  })
  if (check === undefined) {
    log(`Root is locked now: ID refuses the root secret (403 root_locked), because a person holds platform:write.
register goes on as its own machine client, ops-register, which its first run minted. Anything else with
ID's admin API needs your own session or a staff token (apps/web/content/docs/id/onboard.mdx, Get a staff token).
Keep ROOT_ADMIN_SECRET in the GitHub environment, with ROOT_ADMIN_BREAK_GLASS unset: it is the break-glass.`)
    return { platform, member: member.id }
  }
  if (!check.ok) throw failure("GET", "/organizations", check)
  throw new Error(`${email} is in platform-admins, but ID still accepts the root secret: is ROOT_ADMIN_BREAK_GLASS true in ID's environment? Unset it and deploy`)
}
