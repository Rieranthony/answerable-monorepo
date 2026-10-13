import { afterEach, describe, expect, test } from "bun:test"
import { pathsFor } from "./environments"
import { idFirstRun, idMakeAdmin, idOrigin, KEYS } from "./id"
import { formatSecrets } from "./secrets"
import { createContext, createFakeFetch, createFakeRunner, createRoot, json, type RecordedRequest } from "./testing"

const ROOT_SECRET = "root-secret-value"
const TENANT = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
const ORG = "11111111-1111-4111-8111-111111111111"
const GROUP = "22222222-2222-4222-8222-222222222222"
const MEMBER = "33333333-3333-4333-8333-333333333333"
const ADMIN = "https://id.answerable-staging.uk/api/admin/v1"
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`

const SECRETS = formatSecrets({
  "id-env": { BETTER_AUTH_SECRET: "b", UPSTREAM_TOKEN_SECRETS: "[]", ROOT_ADMIN_SECRET: ROOT_SECRET },
  "postgres-admin": { OPS_DATABASE_ADMIN_URL: "postgres://x" },
  "cloudflare-api-token": { "api-token": "t" },
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(values = "hostnames:\n  id: id.answerable-staging.uk\n  toolbox: toolbox.answerable-staging.uk\n") {
  const root = await createRoot({
    "charts/answerable/values-civo-staging.yaml": values,
    "infra/civo/envs/staging/secrets.enc.yaml": "encrypted\nsops:\n",
    ".sops.yaml": "creation_rules: []\n",
  })
  cleanups.push(root.remove)
  const paths = pathsFor("staging", { root: root.path, home: root.path })
  // sops decrypts the Secrets into memory; nothing else runs.
  const runner = createFakeRunner((call) => (call.argv[3] === "decrypt" ? { stdout: SECRETS } : { exitCode: 1 }))
  return { paths, runner }
}

type Overrides = Partial<Record<string, (request: RecordedRequest) => Response | undefined>>

/** ID's admin API as the first run meets it; a test overrides one route by "METHOD path". */
function fakeId(overrides: Overrides = {}) {
  let locked = false
  return createFakeFetch((request) => {
    const path = request.url.slice(ADMIN.length)
    const override = overrides[`${request.method} ${path.split("?")[0]}`]?.(request)
    if (override) return override
    if (locked) return json({ code: "root_locked", title: "Root is locked" }, 403)
    if (request.method === "GET" && path === "/organizations?q=answerable&limit=100")
      return json({
        items: [
          { id: "other", slug: "answerable-labs" },
          { id: ORG, slug: "answerable" },
        ],
        nextCursor: null,
      })
    if (request.method === "POST" && path === `/organizations/${ORG}/domains`) return json({ id: "d1", domain: request.body }, 201)
    if (request.method === "PUT" && path === `/organizations/${ORG}/sso-provider`) return json({ id: "p1" }, 201)
    if (request.method === "GET" && path === `/organizations/${ORG}/sso-provider/test`)
      return json({
        issuer: ISSUER,
        kind: "entra",
        discovery: { url: `${ISSUER}/.well-known/openid-configuration`, reachable: true, status: 200, issuerMatches: true },
        jwks: { reachable: true, keys: 4 },
        elapsedMs: 312,
        problems: [],
      })
    if (request.method === "GET" && path === `/organizations/${ORG}/members?email=you%40answerable.org`)
      return json({ items: [{ id: MEMBER, email: "You@answerable.org" }], nextCursor: null })
    if (request.method === "GET" && path === `/organizations/${ORG}/groups?q=platform-admins&limit=100`)
      return json({ items: [{ id: GROUP, slug: "platform-admins" }], nextCursor: null })
    if (request.method === "PUT" && path === `/organizations/${ORG}/groups/${GROUP}/members/${MEMBER}`) {
      locked = true
      return json({ groupId: GROUP, memberId: MEMBER }, 201)
    }
    return json({ code: "not_found", title: "Not found" }, 404)
  })
}

const FIRST_RUN = { environment: "staging" as const, domain: "Answerable.org", entraTenant: TENANT.toUpperCase() }

describe("id-first-run", () => {
  test("adds the domain and the Entra provider with fixed keys, tests the connection and points at the sign-in", async () => {
    const { paths, runner } = await fixture()
    const id = fakeId()
    const { context, output } = createContext({ run: runner.run, fetch: id.fetch })
    await idFirstRun({ ...FIRST_RUN, paths }, context)
    expect(runner.commands()).toEqual([`sops --config ${paths.sopsConfig} decrypt ${paths.secretsFile}`])
    expect(id.requests.every((request) => request.headers.authorization === `Bearer ${ROOT_SECRET}`)).toBe(true)
    const [, domain, sso] = id.requests
    expect(domain).toMatchObject({ method: "POST", body: { domain: "answerable.org" }, headers: { "idempotency-key": KEYS.domain } })
    expect(sso).toMatchObject({
      method: "PUT",
      url: `${ADMIN}/organizations/${ORG}/sso-provider`,
      body: { issuer: ISSUER, domain: "answerable.org" },
      headers: { "idempotency-key": "platform-sso-setup", "if-none-match": "*", "content-type": "application/json" },
    })
    expect(output()).toContain(`Platform organisation: ${ORG}`)
    expect(output()).toContain("Domain answerable.org: added")
    expect(output()).toContain(`SSO provider ${ISSUER}: connected`)
    expect(output()).toContain("issuer matches")
    expect(output()).toContain("JWKS       reachable, 4 keys")
    expect(output()).toContain("problems   none")
    expect(output()).toContain("https://id.answerable-staging.uk/login")
    expect(output()).toContain("bun run setup id-make-admin --environment staging --email you@answerable.org")
    expect(output()).not.toContain(ROOT_SECRET)
  })

  test("runs again: replays, an equal domain and an equal provider are left as they are", async () => {
    const { paths, runner } = await fixture()
    const replayed = (status: number) => () => json({}, status, { "Idempotency-Replayed": "true" })
    const first = createContext({
      run: runner.run,
      fetch: fakeId({ [`POST /organizations/${ORG}/domains`]: replayed(201), [`PUT /organizations/${ORG}/sso-provider`]: replayed(200) })
        .fetch,
    })
    await idFirstRun({ ...FIRST_RUN, paths }, first.context)
    expect(first.output()).toContain("Domain answerable.org: done before (replayed)")
    expect(first.output()).toContain(`SSO provider ${ISSUER}: done before (replayed)`)

    const existing = fakeId({
      [`POST /organizations/${ORG}/domains`]: () => json({ code: "conflict" }, 409),
      [`GET /organizations/${ORG}/domains`]: () => json({ items: [{ domain: "answerable.org" }] }),
      [`PUT /organizations/${ORG}/sso-provider`]: () => json({ code: "revision_mismatch" }, 412),
      [`GET /organizations/${ORG}/sso-provider`]: () => json({ issuer: ISSUER, domain: "answerable.org" }),
    })
    const second = createContext({ run: runner.run, fetch: existing.fetch })
    await idFirstRun({ ...FIRST_RUN, paths }, second.context)
    expect(second.output()).toContain("Domain answerable.org: already on the platform organisation")
    expect(second.output()).toContain(`SSO provider ${ISSUER}: already connected`)
  })

  test("refuses a domain of another organisation, another provider, and a missing platform application", async () => {
    const { paths, runner } = await fixture()
    const cases: Array<[Overrides, string]> = [
      [
        {
          [`POST /organizations/${ORG}/domains`]: () => json({ code: "conflict" }, 409),
          [`GET /organizations/${ORG}/domains`]: () => json({ items: [] }),
        },
        "the domain answerable.org belongs to another organisation",
      ],
      [
        {
          [`POST /organizations/${ORG}/domains`]: () => json({ code: "conflict" }, 409),
          [`GET /organizations/${ORG}/domains`]: () => json({}, 500),
        },
        `GET /organizations/${ORG}/domains answered 500`,
      ],
      [
        { [`POST /organizations/${ORG}/domains`]: () => json({ code: "validation_failed", detail: "bad" }, 400) },
        "answered 400 validation_failed: bad",
      ],
      [
        {
          [`PUT /organizations/${ORG}/sso-provider`]: () => json({}, 412),
          [`GET /organizations/${ORG}/sso-provider`]: () => json({ issuer: "https://accounts.google.com", domain: "answerable.org" }),
        },
        "already has an SSO provider (issuer https://accounts.google.com, domain answerable.org)",
      ],
      [
        {
          [`PUT /organizations/${ORG}/sso-provider`]: () => json({}, 412),
          [`GET /organizations/${ORG}/sso-provider`]: () => json({}, 503),
        },
        `GET /organizations/${ORG}/sso-provider answered 503`,
      ],
      [
        { [`PUT /organizations/${ORG}/sso-provider`]: () => json({ code: "platform_application_missing" }, 400) },
        "ID has no Microsoft platform application",
      ],
      [
        { [`PUT /organizations/${ORG}/sso-provider`]: () => json({ code: "conflict", title: "Conflict" }, 409) },
        "answered 409 conflict: Conflict",
      ],
      [{ [`GET /organizations/${ORG}/sso-provider/test`]: () => json({}, 404) }, "/sso-provider/test answered 404"],
      [{ "GET /organizations": () => json({ items: [] }) }, "ID has no organisation with the slug answerable"],
      [{ "GET /organizations": () => new Response("<html>", { status: 502 }) }, "answered 502 <html>"],
      [
        { "GET /organizations": () => new Response("", { status: 401 }) },
        "the deployment's ROOT_ADMIN_SECRET is not the one in the sops file",
      ],
      [{ "GET /organizations": () => json({ code: "root_locked" }, 403) }, "403 root_locked"],
      [
        { [`POST /organizations/${ORG}/domains`]: () => json({ code: "idempotency_key_reused" }, 409) },
        "ID refused Idempotency-Key platform-domain-setup",
      ],
    ]
    for (const [overrides, message] of cases)
      await expect(
        idFirstRun({ ...FIRST_RUN, paths }, createContext({ run: runner.run, fetch: fakeId(overrides).fetch }).context),
      ).rejects.toThrow(message)
  })

  test("prints the test's problems and fails", async () => {
    const { paths, runner } = await fixture()
    const failing = fakeId({
      [`GET /organizations/${ORG}/sso-provider/test`]: () =>
        json({
          kind: "entra",
          discovery: { url: "u", reachable: false, status: null, issuerMatches: null },
          jwks: { reachable: false, keys: null },
          elapsedMs: 5,
          problems: [{ code: "discovery_unreachable", detail: "timeout" }],
        }),
    })
    const { context, output } = createContext({ run: runner.run, fetch: failing.fetch })
    await expect(idFirstRun({ ...FIRST_RUN, paths }, context)).rejects.toThrow("the connectivity test found problems")
    expect(output()).toContain("unreachable, HTTP none, issuer does not match")
    expect(output()).toContain("JWKS       unreachable, 0 keys")
    expect(output()).toContain("problems   discovery_unreachable: timeout")
  })

  test("checks its options and the values file", async () => {
    const { paths, runner } = await fixture()
    const { context } = createContext({ run: runner.run, fetch: fakeId().fetch })
    await expect(idFirstRun({ ...FIRST_RUN, paths, domain: "not a domain" }, context)).rejects.toThrow("--domain must be a domain")
    await expect(idFirstRun({ ...FIRST_RUN, paths, entraTenant: "contoso" }, context)).rejects.toThrow(
      "--entra-tenant must be the tenant's ID",
    )
    const noHost = await fixture("hostnames: {}\n")
    await expect(idOrigin(noHost.paths)).rejects.toThrow("charts/answerable/values-civo-staging.yaml has no hostnames.id")
    const broken = await fixture("hostnames: [\n")
    await expect(idOrigin(broken.paths)).rejects.toThrow("cannot read charts/answerable/values-civo-staging.yaml")
    expect(await idOrigin(paths)).toBe("https://id.answerable-staging.uk")
  })
})

describe("id-make-admin", () => {
  test("puts the member in platform-admins with the fixed key and confirms root is locked", async () => {
    const { paths, runner } = await fixture()
    const id = fakeId()
    const { context, output } = createContext({ run: runner.run, fetch: id.fetch })
    await idMakeAdmin({ environment: "staging", paths, email: "you@answerable.org" }, context)
    const put = id.requests.find((request) => request.method === "PUT")!
    expect(put).toMatchObject({
      url: `${ADMIN}/organizations/${ORG}/groups/${GROUP}/members/${MEMBER}`,
      body: {},
      headers: { "idempotency-key": "platform-admin-membership-setup", "if-none-match": "*" },
    })
    expect(id.requests.at(-1)!.url).toBe(`${ADMIN}/organizations?limit=1`)
    expect(output()).toContain(`you@answerable.org (member ${MEMBER}): added to platform-admins`)
    expect(output()).toContain("Root is locked now")
    expect(output()).toContain("Secret ops-staff-token (key OPS_ID_TOKEN)")
    expect(output()).not.toContain(ROOT_SECRET)
  })

  test("says when the member is already an administrator, or when root is still open", async () => {
    const { paths, runner } = await fixture()
    const open = fakeId({
      [`PUT /organizations/${ORG}/groups/${GROUP}/members/${MEMBER}`]: () => json({}, 412),
    })
    const { context, output } = createContext({ run: runner.run, fetch: open.fetch })
    await idMakeAdmin({ environment: "staging", paths, email: "you@answerable.org" }, context)
    expect(output()).toContain("already in platform-admins")
    expect(output()).toContain("Warning: ID still accepts the root secret")
  })

  test("needs a signed-in member and the platform-admins group", async () => {
    const { paths, runner } = await fixture()
    const cases: Array<[Overrides, string]> = [
      [
        { [`GET /organizations/${ORG}/members`]: () => json({ items: [] }) },
        "no member of the platform organisation has the email you@answerable.org: sign in once at https://id.answerable-staging.uk/login",
      ],
      [{ [`GET /organizations/${ORG}/members`]: () => json({}, 400) }, "answered 400"],
      [{ [`GET /organizations/${ORG}/groups`]: () => json({ items: [] }) }, "no platform-admins group"],
      [{ [`GET /organizations/${ORG}/groups`]: () => json({}, 500) }, "answered 500"],
      [
        { [`PUT /organizations/${ORG}/groups/${GROUP}/members/${MEMBER}`]: () => json({ code: "not_found" }, 404) },
        "answered 404 not_found",
      ],
      [{ "GET /organizations": (request) => (request.url.endsWith("limit=1") ? new Response("", { status: 401 }) : undefined) }, "(401)"],
    ]
    for (const [overrides, message] of cases)
      await expect(
        idMakeAdmin(
          { environment: "staging", paths, email: "you@answerable.org" },
          createContext({ run: runner.run, fetch: fakeId(overrides).fetch }).context,
        ),
      ).rejects.toThrow(message)
    await expect(idMakeAdmin({ environment: "staging", paths, email: "you" }, createContext({ run: runner.run }).context)).rejects.toThrow(
      "--email must be an email address",
    )
  })
})
