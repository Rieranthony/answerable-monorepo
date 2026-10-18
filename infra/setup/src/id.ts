import { readFile } from "node:fs/promises"
import type { Context } from "./context"
import { PLATFORM_SLUG, shown, type EnvironmentName, type Paths } from "./environments"
import { SetupError, UsageError } from "./errors"
import { readRootSecret } from "./secrets"

/** The `Idempotency-Key`s of the first run, the same as `apps/web/content/docs/id/onboard.mdx` § First run uses. */
export const KEYS = {
  domain: "platform-domain-setup",
  sso: "platform-sso-setup",
  admin: "platform-admin-membership-setup",
  /** The key `register`'s printed command uses for the same membership (`infra/ops/src/register.ts`). */
  owner: "admin-first-owner-v1",
} as const

/** The admin MCP's owner role: the group `register` creates in the platform organisation, with its entitlement. */
const OWNER_GROUP = "answerable-owner"

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Problem = { code?: string; title?: string; detail?: string }
type Answer = { status: number; body: Record<string, unknown> & Problem; replayed: boolean }
type CallOptions = { key?: string; body?: unknown; ifNoneMatch?: boolean }

/** ID's public origin, from the `hostnames.id` of the environment's chart values. */
export async function idOrigin(paths: Paths): Promise<string> {
  let values: { hostnames?: { id?: unknown } } | null
  try {
    values = Bun.YAML.parse(await readFile(paths.valuesFile, "utf8")) as typeof values
  } catch (error) {
    throw new SetupError(`cannot read ${shown(paths, paths.valuesFile)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const host = values?.hostnames?.id
  if (typeof host !== "string" || !DOMAIN.test(host)) throw new SetupError(`${shown(paths, paths.valuesFile)} has no hostnames.id`)
  return `https://${host}`
}

/** The admin API of ID with the root secret as the bearer, as `apps/web/content/docs/id/onboard.mdx` § First run calls it. */
function adminApi(context: Context, origin: string, root: string) {
  return async (method: string, path: string, options: CallOptions = {}): Promise<Answer> => {
    const response = await context.fetch(`${origin}/api/admin/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${root}`,
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
        ...(options.ifNoneMatch ? { "If-None-Match": "*" } : {}),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const text = await response.text()
    let body: Answer["body"]
    try {
      body = text ? (JSON.parse(text) as Answer["body"]) : {}
    } catch {
      body = { detail: text.slice(0, 200) }
    }
    if (response.status === 401)
      throw new SetupError("ID refused the root secret (401): the deployment's ROOT_ADMIN_SECRET is not the one in the sops file")
    if (response.status === 403 && body.code === "root_locked")
      throw new SetupError(
        "ID refused the root secret (403 root_locked): a platform administrator exists, so the first run is over. " +
          "Further changes need a staff token (apps/web/content/docs/id/onboard.mdx, Get a staff token)",
      )
    if (response.status === 409 && body.code === "idempotency_key_reused")
      throw new SetupError(
        `ID refused Idempotency-Key ${options.key}: it was used before with other input. Run the step by hand with a new key (onboard.mdx, First run)`,
      )
    return { status: response.status, body, replayed: response.headers.get("Idempotency-Replayed") === "true" }
  }
}

function failure(method: string, path: string, answer: Answer): SetupError {
  const reason = [answer.body.code, answer.body.detail ?? answer.body.title].filter(Boolean).join(": ")
  return new SetupError(`${method} ${path} answered ${answer.status}${reason ? ` ${reason}` : ""}`)
}

async function platformOrganisation(call: ReturnType<typeof adminApi>): Promise<string> {
  const path = `/organizations?q=${PLATFORM_SLUG}&limit=100`
  const answer = await call("GET", path)
  if (answer.status !== 200) throw failure("GET", path, answer)
  const found = (answer.body.items as { id: string; slug: string }[]).find((item) => item.slug === PLATFORM_SLUG)
  if (!found) throw new SetupError(`ID has no organisation with the slug ${PLATFORM_SLUG}: has it started once against its database?`)
  return found.id
}

function done(answer: Answer, created: string): string {
  return answer.replayed ? "done before (replayed)" : created
}

async function readRoot(context: Context, paths: Paths): Promise<{ origin: string; call: ReturnType<typeof adminApi> }> {
  const origin = await idOrigin(paths)
  const root = await readRootSecret(context, paths)
  return { origin, call: adminApi(context, origin, root) }
}

/** What `id-first-run` does. */
export type IdFirstRunOptions = {
  environment: EnvironmentName
  paths: Paths
  /** The staff email domain, such as `answerable.org`. */
  domain: string
  /** The Microsoft Entra tenant that signs the staff in. */
  entraTenant: string
}

/**
 * ID's first run with the root secret (`apps/web/content/docs/id/onboard.mdx` § First run, steps 2 and 3): find the
 * platform organisation, add the staff domain, connect the Entra tenant through Answerable's platform application,
 * test the connection and print where to sign in. Safe to run again: the keys are fixed, so a step ID has seen replays,
 * and an equal domain or provider that exists already is left as it is.
 */
export async function idFirstRun(options: IdFirstRunOptions, context: Context): Promise<void> {
  const domain = options.domain.trim().toLowerCase()
  const tenant = options.entraTenant.trim().toLowerCase()
  if (!DOMAIN.test(domain)) throw new UsageError(`--domain must be a domain such as answerable.org, got "${options.domain}"`)
  if (!TENANT.test(tenant)) throw new UsageError("--entra-tenant must be the tenant's ID, a GUID (Entra admin centre > Overview)")
  const { origin, call } = await readRoot(context, options.paths)
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`
  context.out(`ID: ${origin}\n`)

  const org = await platformOrganisation(call)
  context.out(`Platform organisation: ${org}\n`)

  const domains = `/organizations/${org}/domains`
  const added = await call("POST", domains, { key: KEYS.domain, body: { domain } })
  if (added.status === 201) context.out(`Domain ${domain}: ${done(added, "added")}\n`)
  else if (added.status === 409) {
    const listed = await call("GET", `${domains}?limit=200`)
    if (listed.status !== 200) throw failure("GET", domains, listed)
    if (!(listed.body.items as { domain: string }[]).some((item) => item.domain === domain))
      throw new SetupError(`the domain ${domain} belongs to another organisation; remove it there first`)
    context.out(`Domain ${domain}: already on the platform organisation\n`)
  } else throw failure("POST", domains, added)

  const provider = `/organizations/${org}/sso-provider`
  const put = await call("PUT", provider, { key: KEYS.sso, ifNoneMatch: true, body: { issuer, domain } })
  if (put.status === 200 || put.status === 201) context.out(`SSO provider ${issuer}: ${done(put, "connected")}\n`)
  else if (put.status === 412) {
    const current = await call("GET", provider)
    if (current.status !== 200) throw failure("GET", provider, current)
    if (current.body.issuer !== issuer || current.body.domain !== domain)
      throw new SetupError(
        `the platform organisation already has an SSO provider (issuer ${String(current.body.issuer)}, domain ${String(current.body.domain)}). ` +
          "Replacing it signs everyone out of it: do that by hand with If-Match (onboard.mdx)",
      )
    context.out(`SSO provider ${issuer}: already connected\n`)
  } else if (put.body.code === "platform_application_missing")
    throw new SetupError(
      "ID has no Microsoft platform application: set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET, run " +
        "init-secrets --rotate MICROSOFT_CLIENT_SECRET, deploy, and run this again",
    )
  else throw failure("PUT", provider, put)

  const test = await call("GET", `${provider}/test`)
  if (test.status !== 200) throw failure("GET", `${provider}/test`, test)
  const result = test.body as unknown as {
    kind: string
    discovery: { url: string; reachable: boolean; status: number | null; issuerMatches: boolean | null }
    jwks: { reachable: boolean; keys: number | null }
    elapsedMs: number
    problems: { code: string; detail: string }[]
  }
  context.out(`
Connectivity test (${result.kind}, ${result.elapsedMs} ms):
  discovery  ${result.discovery.url}: ${result.discovery.reachable ? "reachable" : "unreachable"}, HTTP ${result.discovery.status ?? "none"}, issuer ${result.discovery.issuerMatches ? "matches" : "does not match"}
  JWKS       ${result.jwks.reachable ? "reachable" : "unreachable"}, ${result.jwks.keys ?? 0} keys
  problems   ${result.problems.length ? result.problems.map((problem) => `${problem.code}: ${problem.detail}`).join("; ") : "none"}
`)
  if (result.problems.length) throw new SetupError("the connectivity test found problems; fix them, then run this again")
  context.out(`
The test cannot prove the credentials; a sign-in does. Sign in once with your work account at
  ${origin}/login
which creates your membership of the platform organisation. Then make yourself its administrator:
  bun run setup id-make-admin --environment ${options.environment} --email you@${domain}
`)
}

/** What `id-make-admin` does. */
export type IdMakeAdminOptions = { environment: EnvironmentName; paths: Paths; email: string }

/**
 * Give the first staff member the admin MCP's owner role (the group `answerable-owner`, when `register` has created it),
 * then put them in `platform-admins` with the root secret (`onboard.mdx` § First run, step 5), which locks the root
 * secret: a person holds `platform:write` now. The owner role comes first because nothing can use the root secret after.
 * Confirms the lock with one more call.
 */
export async function idMakeAdmin(options: IdMakeAdminOptions, context: Context): Promise<void> {
  const email = options.email.trim()
  if (!EMAIL.test(email)) throw new UsageError(`--email must be an email address, got "${options.email}"`)
  const { origin, call } = await readRoot(context, options.paths)
  const org = await platformOrganisation(call)

  const members = `/organizations/${org}/members?email=${encodeURIComponent(email)}`
  const listed = await call("GET", members)
  if (listed.status !== 200) throw failure("GET", members, listed)
  const member = (listed.body.items as { id: string; email: string }[]).find((item) => item.email.toLowerCase() === email.toLowerCase())
  if (!member) throw new SetupError(`no member of the platform organisation has the email ${email}: sign in once at ${origin}/login first`)

  const owners = `/organizations/${org}/groups?q=${OWNER_GROUP}&limit=100`
  const ownersFound = await call("GET", owners)
  if (ownersFound.status !== 200) throw failure("GET", owners, ownersFound)
  const ownerGroup = (ownersFound.body.items as { id: string; slug: string }[]).find((item) => item.slug === OWNER_GROUP)
  if (ownerGroup) {
    const ownerPath = `/organizations/${org}/groups/${ownerGroup.id}/members/${member.id}`
    const ownerPut = await call("PUT", ownerPath, { key: KEYS.owner, ifNoneMatch: true, body: {} })
    if (ownerPut.status === 200 || ownerPut.status === 201)
      context.out(`${email} (member ${member.id}): ${done(ownerPut, `added to ${OWNER_GROUP}, the admin MCP's owner role`)}\n`)
    else if (ownerPut.status === 412) context.out(`${email} (member ${member.id}): already in ${OWNER_GROUP}\n`)
    else throw failure("PUT", ownerPath, ownerPut)
  } else
    context.out(
      `The platform organisation has no ${OWNER_GROUP} group yet: the first deploy's register creates it. Give yourself the\n` +
        "admin MCP's owner role later with a staff token, as infra/README.md (First-time setup) shows.\n",
    )

  const groups = `/organizations/${org}/groups?q=platform-admins&limit=100`
  const found = await call("GET", groups)
  if (found.status !== 200) throw failure("GET", groups, found)
  const group = (found.body.items as { id: string; slug: string }[]).find((item) => item.slug === "platform-admins")
  if (!group) throw new SetupError("the platform organisation has no platform-admins group: ID seeds it at its first start")

  const path = `/organizations/${org}/groups/${group.id}/members/${member.id}`
  const put = await call("PUT", path, { key: KEYS.admin, ifNoneMatch: true, body: {} })
  if (put.status === 200 || put.status === 201) context.out(`${email} (member ${member.id}): ${done(put, "added to platform-admins")}\n`)
  else if (put.status === 412) context.out(`${email} (member ${member.id}): already in platform-admins\n`)
  else throw failure("PUT", path, put)

  let locked = false
  try {
    await call("GET", `/organizations?limit=1`)
  } catch (error) {
    if (!(error instanceof SetupError) || !error.message.includes("root_locked")) throw error
    locked = true
  }
  context.out(
    locked
      ? "Root is locked now: ID refuses the root secret (403 root_locked), because a person holds platform:write.\n"
      : "Warning: ID still accepts the root secret. Is ROOT_ADMIN_BREAK_GLASS=true in the deployment? Set it to false.\n",
  )
  context.out(`
From now on register, and anything else with ID's admin API, needs a staff token: get one as
apps/web/content/docs/id/onboard.mdx (Get a staff token) says and put it in the Secret ops-staff-token (key OPS_ID_TOKEN)
in namespace answerable, then run the ops workflow's register for ${options.environment}. Keep ROOT_ADMIN_SECRET in the sops
file with ROOT_ADMIN_BREAK_GLASS=false: it is the break-glass.
`)
}
