// bun mcp setup: connects bun mcp to the developer's local Answerable ID, once. It makes a machine client there, mcp-dev, and writes its id and secret,
// with the developer's organisation, to the root .env. Run again, it finds the client working and does nothing.
import { failure, findBySlug, RootLocked, type Call } from "../../../infra/ops/src/admin-api"
import { cancelled } from "../ask"
import { organisationSlug } from "../config"
import { definitions } from "../definitions"
import { readSettings, writeEnvironment } from "../environment"
import { Refusal, runSteps, valueOf, type Command, type Io } from "../io"
import { local } from "../local"
import { adminCall, counts, createRegistrar, machine, machineToken, makeMcpDev, platformSlug, registerToolbox } from "../local-id"
import { findRoot } from "../workspace"

const { usage } = definitions.setup
/** Where a staff token comes from. */
export const onboarding = "https://www.answerable.org/docs/id/onboard#get-a-staff-token"
const withStaffToken = "bun mcp setup --staff-token <token>"

/** ID's admin API behind a bearer it accepts, and the platform organisation's id. */
type Access = { call: Call; platform: string }

// The platform organisation read with `token`: the access when ID accepts the bearer, else why it does not.
async function tryToken(io: Io, token: string, what: string): Promise<Access | { refused: string }> {
  const call = adminCall(io.fetch, token)
  const answer = await call("GET", `/organizations?q=${platformSlug}&limit=100`).catch((error: unknown) => (error instanceof RootLocked ? undefined : Promise.reject(error)))
  if (!answer) return { refused: "ID's root secret is locked: a person is a platform administrator" }
  if (answer.status === 401) return { refused: `ID refused ${what}` }
  if (!answer.ok) throw failure("GET", "/organizations", answer)
  const platform = (answer.body.items as { id: string; slug: string }[]).find(item => item.slug === platformSlug)?.id
  if (!platform) throw new Refusal("platform-organisation-missing", `Answerable ID has no organisation ${platformSlug}, which it makes at its first start: start it once, then run bun mcp setup again`, "bun mcp setup")
  return { call, platform }
}

const accepted = (result: Access | { refused: string }) => {
  if ("call" in result) return result
  throw new Refusal("staff-token-refused", `ID refused the staff token; get another (${onboarding})`, withStaffToken)
}

// The access setup needs: with --staff-token, that; else the root secret while ID's root is unlocked; else a staff token asked for in a terminal, or
// refused without one, naming the flag.
async function access(io: Io, staff: string | undefined, rootSecret: string): Promise<Access> {
  if (staff !== undefined) return accepted(await tryToken(io, staff, "the staff token"))
  const rooted = await tryToken(io, rootSecret, "ROOT_ADMIN_SECRET")
  if ("call" in rooted) return rooted
  const why = `${rooted.refused}, so bun mcp setup needs a staff token`
  if (!io.isTTY) throw new Refusal("staff-token-required", `${why}: pass it with --staff-token (get one at ${onboarding})`, withStaffToken)
  const answer = await io.prompts.password({ message: `${why}. Paste one (get it at ${onboarding}); it is not shown or stored`, input: io.stdin, output: io.stdout, validate: value => (value ? undefined : "A staff token is required") })
  if (typeof answer === "symbol") throw cancelled("bun mcp setup")
  return accepted(await tryToken(io, answer, "the staff token"))
}

export const setup: Command = {
  ...definitions.setup,
  async run(io, { positionals, flags }) {
    if (positionals.length) throw new Refusal("unexpected-argument", `bun mcp setup takes no argument; it was given ${positionals.join(", ")}`, usage)
    const root = findRoot(io.cwd)
    const { settings } = await readSettings(root)
    const organisation = valueOf(flags.organisation) ?? settings.MCP_DEV_ORGANISATION
    if (!organisationSlug.test(organisation)) throw new Refusal("invalid-organisation", `--organisation ${organisation} is not an organisation's slug: lowercase letters and digits, words joined by single hyphens`, usage)
    if (!(await io.fetch(`${local.id}/healthz`, { signal: AbortSignal.timeout(5000) }).then(answer => answer.ok, () => false))) {
      throw new Refusal("id-down", `Answerable ID does not answer on ${local.id}. Start it from the main checkout with bun dev, or with bun --filter @answerable/id dev; never bun dev from a worktree, where it runs env:up and recreates the shared Postgres. Then run bun mcp setup again`, "bun --filter @answerable/id dev")
    }
    const { MCP_DEV_ID_CLIENT_ID: clientId, MCP_DEV_ID_CLIENT_SECRET: clientSecret } = settings
    const token = clientId && clientSecret ? await machineToken(io.fetch, { clientId, clientSecret }, local.adminResource, "platform:read platform:write") : undefined
    const staff = valueOf(flags["staff-token"])
    // A client that works is its own access and needs no platform organisation's id; otherwise a bearer is needed, which also gives the id.
    const { call, platform } = token ? { call: adminCall(io.fetch, token), platform: undefined } : await access(io, staff, settings.ROOT_ADMIN_SECRET ?? "")
    if (!(await findBySlug(call, "/organizations", organisation))) {
      throw new Refusal("organisation-not-found", `Answerable ID has no organisation ${organisation}; pass its slug with --organisation, or leave it out for ${platformSlug}`, usage)
    }
    const json = flags.json === true
    if (!platform) {
      // Nothing to make: at most the organisation changes.
      const steps = [
        { name: "client", fix: "bun mcp setup", run: async () => `${machine} works: ID accepts its credentials in .env; nothing to do` },
        ...(organisation === settings.MCP_DEV_ORGANISATION ? [] : [{ name: "env", fix: "bun mcp setup", run: async () => (await writeEnvironment(root, { MCP_DEV_ORGANISATION: organisation }), `MCP_DEV_ORGANISATION=${organisation} written to .env`) }]),
      ]
      return runSteps(io, json, steps, () => ["bun mcp dev <mcp>"])
    }
    const registrar = createRegistrar(call)
    let secret = ""
    return runSteps(io, json, [
      {
        name: "toolbox", fix: "bun mcp setup",
        run: async () => (await registerToolbox(registrar), `${local.toolboxResource}, its admin resource and claude-code-toolbox: ${counts(registrar)}`),
      },
      {
        name: "client", fix: "bun mcp setup",
        run: async () => {
          const made = await makeMcpDev(registrar, platform)
          secret = made.clientSecret
          return `${machine} ${made.made ? "made" : "found, with a new secret"}: platform:read platform:write on ID, toolbox:admin on the Toolbox`
        },
      },
      {
        name: "env", fix: "bun mcp setup",
        run: async () => (await writeEnvironment(root, { MCP_DEV_ID_CLIENT_ID: machine, MCP_DEV_ID_CLIENT_SECRET: secret, MCP_DEV_ORGANISATION: organisation }), `MCP_DEV_ID_CLIENT_ID, MCP_DEV_ID_CLIENT_SECRET and MCP_DEV_ORGANISATION=${organisation} written to .env`),
      },
    ], () => ["bun mcp list", "bun mcp dev <mcp>"])
  },
}
