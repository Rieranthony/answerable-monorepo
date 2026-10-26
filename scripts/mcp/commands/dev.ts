// bun mcp dev [mcp]: runs an MCP on this machine, against the development Postgres and the local Answerable ID, and prints the command that connects
// Claude Code to it. It migrates the local schemas of the MCPs the servers mount and the servers' own databases, starts the Toolbox or the standalone server
// (both, for `both`) with hot reload and waits for each to list the MCP, registers a standalone MCP in the local ID, and gives the developer's organisation
// access, then runs until Ctrl-C and stops what it started.
import { join } from "node:path"
import { findBySlug } from "../../../infra/ops/src/admin-api"
import { scopesOf } from "../generate"
import { cli, refusal, Refusal, runSteps, sh, type Command, type Io, type Problem, type Running, type Step } from "../io"
import { listed } from "../rules"
import { readSettings } from "../environment"
import { local } from "../local"
import { enableInToolbox, giveStandaloneAccess } from "../local-access"
import { adminCall, createRegistrar, machineToken, registerStandalone } from "../local-id"
import { servers, startServer, type ServerName } from "../servers"
import { declarations, findRoot, manifestOf, resolveMcp, type Declaration } from "../workspace"

const usage = "bun mcp dev [mcp]"
const servedBy: Record<Declaration["serve"], readonly ServerName[]> = { toolbox: ["toolbox"], standalone: ["standalone"], both: ["toolbox", "standalone"] }
type Settings = Awaited<ReturnType<typeof readSettings>>["settings"]

// What stops bun mcp dev before it starts anything: each, with the command that fixes it, and mcp-dev's token and the developer's organisation id when
// ID gave them.
async function preflight(io: Io, mcp: Declaration, settings: Settings, wanted: readonly ServerName[], hasManifest: boolean) {
  const problems: Problem[] = []
  const { MCP_DEV_ID_CLIENT_ID: clientId, MCP_DEV_ID_CLIENT_SECRET: clientSecret } = settings
  const refuse = (code: string, message: string) => problems.push({ code, message })
  if (!clientId || !clientSecret) refuse("setup-required", "bun mcp setup has not run: MCP_DEV_ID_CLIENT_ID and MCP_DEV_ID_CLIENT_SECRET are not in .env. Run bun mcp setup")
  const up = await io.fetch(`${local.id}/healthz`, { signal: AbortSignal.timeout(5000) }).then(answer => answer.ok, () => false)
  if (!up) refuse("id-down", `Answerable ID does not answer on ${local.id}. Start it from the main checkout with bun dev, or with bun --filter @answerable/id dev; never bun dev from a worktree, where it runs env:up and recreates the shared Postgres`)
  const token = up && clientId && clientSecret ? await machineToken(io.fetch, { clientId, clientSecret }, local.adminResource, "platform:read platform:write") : undefined
  if (up && clientId && !token) refuse("setup-stale", "ID refused the credentials of mcp-dev in .env, as after a reset of its database. Run bun mcp setup again")
  const organisation = token ? await findBySlug(adminCall(io.fetch, token), "/organizations", settings.MCP_DEV_ORGANISATION) : undefined
  if (token && !organisation) refuse("organisation-not-found", `Answerable ID has no organisation ${settings.MCP_DEV_ORGANISATION}. Run bun mcp setup --organisation <slug> with the slug of yours`)
  const postgres = new URL(settings.MCPS_DATABASE_ADMIN_URL)
  if (!(await io.listening(postgres.hostname, Number(postgres.port || 5432)))) {
    refuse("postgres-down", `The development Postgres does not answer on ${postgres.host}. Start it from the main checkout with bun run env:up; never from a worktree, where it recreates the running one`)
  }
  for (const which of wanted) {
    const { name, port } = servers[which]
    if (await io.listening("127.0.0.1", port)) refuse("port-taken", `Port ${port} is taken, and ${name} needs it: stop what listens there (lsof -nP -iTCP:${port} -sTCP:LISTEN names it)`)
  }
  if (mcp.serve !== "toolbox" && !hasManifest) refuse("manifest-missing", `mcps/${mcp.name}/manifest.json does not exist, and the MCP's scopes in ID come from it. Run bun mcp check ${mcp.name}`)
  return { problems, token, organisation, clientId: clientId!, clientSecret: clientSecret! }
}

export const dev: Command = {
  name: "dev",
  usage,
  summary: "Run an MCP on this machine, migrated, in the Toolbox or the standalone server as its serve says, with hot reload; register it in your local ID, give your organisation access, and print the claude mcp add command that connects Claude Code. It runs until Ctrl-C, which stops what it started. Needs bun mcp setup once",
  flags: {},
  example: "bun mcp dev acme",
  async run(io, { positionals }) {
    if (positionals.length > 1) throw new Refusal("unexpected-argument", `bun mcp dev takes one MCP; it was given ${positionals.join(", ")}`, usage)
    const root = findRoot(io.cwd)
    const mcp = await resolveMcp(root, io.cwd, positionals[0], "bun mcp dev <mcp>")
    const { name } = mcp
    const { env, settings } = await readSettings(root)
    const wanted = servedBy[mcp.serve]
    const manifest = await manifestOf(root, name)
    const mounts = (await declarations(root)).filter(other => servedBy[other.serve].some(which => wanted.includes(which)))
    const again = `bun mcp dev ${name}`
    const { problems, token, organisation, clientId, clientSecret } = await preflight(io, mcp, settings, wanted, manifest !== undefined)
    if (problems.length) throw refusal(problems, again)
    const signal = io.interrupt()
    const call = adminCall(io.fetch, token!)
    const started: Running[] = []
    const address = { toolbox: local.toolboxResource, standalone: `${local.standalone}/${name}/mcp` }
    const standalone = wanted.includes("standalone")
    const steps: Step[] = [
      {
        // Every MCP a started server mounts must have its schema and roles, or the server refuses to start; and each server's own database its tables.
        name: "database", fix: again,
        run: async () => {
          for (const { name: mounted } of mounts) await sh(io, [process.execPath, cli, "db", mounted, "migrate"], root, env)
          for (const which of wanted) await sh(io, [process.execPath, "run", "db:migrate"], join(root, servers[which].workspace), env)
          return `schemas ${listed(mounts.map(mounted => mounted.name), "and")}; ${wanted.length > 1 ? "the databases" : "the database"} of ${listed(wanted.map(which => servers[which].name), "and")}`
        },
      },
      ...wanted.map(which => ({
        name: which, fix: again,
        run: async () => {
          const [id, secret] = servers[which].client
          await startServer(io, root, which, name, { ...env, [id]: clientId, [secret]: clientSecret }, started)
          return `serving ${name} at ${address[which]}`
        },
      })),
      ...(standalone ? [
        {
          name: "register", fix: again,
          run: async () => {
            const registrar = createRegistrar(call)
            await registerStandalone(registrar, { name, scopes: scopesOf(manifest!) })
            return `${address.standalone} and claude-code-${name}: ${registrar.counts()}`
          },
        },
        { name: "access", fix: again, run: async () => `organisation ${settings.MCP_DEV_ORGANISATION}: ${await giveStandaloneAccess(call, organisation!, name)}` },
      ] : []),
      ...(wanted.includes("toolbox") ? [{ name: "enable", fix: again, run: async () => `organisation ${settings.MCP_DEV_ORGANISATION}: ${await enableInToolbox(io, call, { clientId, clientSecret }, organisation!, name)}` }] : []),
    ]
    let code: number
    try {
      code = await runSteps(io, false, steps, () => [])
      if (code === 0) code = await running(io, signal, started, name, wanted, settings.MCP_DEV_ORGANISATION)
    } finally {
      for (const server of started.toReversed()) await server.stop()
    }
    return code
  },
}

// Print what to do next, then wait for Ctrl-C or for a server to stop; 0 after Ctrl-C, 1 after a server stopped.
async function running(io: Io, signal: AbortSignal, started: readonly Running[], name: string, wanted: readonly ServerName[], organisation: string) {
  const claude = (connection: string, url: string, client: string) => `  claude mcp add --transport http ${connection} ${url} --client-id ${client} --callback-port ${local.callbackPort}`
  const blocks = wanted.map(which => which === "toolbox"
    ? `${name} runs in the Toolbox at ${local.toolboxResource}, as the tools ${name}_*.\n\n${claude("answerable-toolbox", local.toolboxResource, "claude-code-toolbox")}\n\nIn Claude Code, run /mcp, choose answerable-toolbox, then Authenticate.\nEnabling ${name} for organisation ${organisation} and granting it to everyone there are local conveniences: in staging and production, staff do both (toolbox_enable and access_grant in the admin MCP).`
    : `${name} runs at ${local.standalone}/${name}/mcp\n\n${claude(name, `${local.standalone}/${name}/mcp`, `claude-code-${name}`)}\n\nIn Claude Code, run /mcp, choose ${name}, then Authenticate.`)
  io.stdout.write(`\n${blocks.join("\n\n")}\n\nCtrl-C stops ${wanted.map(which => servers[which].name).join(" and ")}; an edit to ${name} reloads ${wanted.length > 1 ? "them" : "it"}.\n`)
  const interrupted = new Promise<"interrupted">(resolve => (signal.aborted ? resolve("interrupted") : signal.addEventListener("abort", () => resolve("interrupted"), { once: true })))
  const ended = await Promise.race([interrupted, ...started.map((server, index) => server.exited.then(code => ({ index, code })))])
  if (ended === "interrupted") return (io.stdout.write(`\nStopping ${wanted.map(which => servers[which].name).join(" and ")}.\n`), 0)
  io.stderr.write(`\n${servers[wanted[ended.index]!].name} stopped with exit code ${ended.code}; its output above says why. Run bun mcp dev ${name} again.\n`)
  return 1
}
