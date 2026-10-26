// bun mcp dev [mcp]: runs an MCP on this machine, against the development Postgres and the local Answerable ID, and prints the command that connects
// Claude Code to it. It migrates the local schemas of every MCP the Toolbox serves and the Toolbox's own database, starts the Toolbox with hot reload,
// which serves the MCP in its hub, at its own path or both, and waits for it to list the MCP, registers a standalone MCP in the local ID, and gives the
// developer's organisation access, then runs until Ctrl-C and stops the Toolbox.
import { join } from "node:path"
import { findBySlug } from "../../../infra/ops/src/admin-api"
import { definitions } from "../definitions"
import { readSettings } from "../environment"
import { scopesOf } from "../generate"
import { cli, refusal, Refusal, runSteps, sh, type Command, type Io, type Problem, type Running, type Step } from "../io"
import { local } from "../local"
import { enableInToolbox, giveStandaloneAccess } from "../local-access"
import { adminCall, counts, createRegistrar, machineToken, registerStandalone } from "../local-id"
import { listed } from "../rules"
import { startToolbox, toolbox } from "../servers"
import { declarations, findRoot, manifestOf, resolveMcp, type Declaration } from "../workspace"

const { usage } = definitions.dev
type Settings = Awaited<ReturnType<typeof readSettings>>["settings"]

// What stops bun mcp dev before it starts anything: each, with the command that fixes it, and mcp-dev's token and the developer's organisation id when
// ID gave them.
async function preflight(io: Io, mcp: Declaration, settings: Settings, hasManifest: boolean) {
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
  const { name, port } = toolbox
  if (await io.listening("127.0.0.1", port)) refuse("port-taken", `Port ${port} is taken, and ${name} needs it: stop what listens there (lsof -nP -iTCP:${port} -sTCP:LISTEN names it)`)
  if (mcp.serve !== "toolbox" && !hasManifest) refuse("manifest-missing", `mcps/${mcp.name}/manifest.json does not exist, and the MCP's scopes in ID come from it. Run bun mcp check ${mcp.name}`)
  return { problems, token, organisation, clientId: clientId!, clientSecret: clientSecret! }
}

export const dev: Command = {
  ...definitions.dev,
  async run(io, { positionals }) {
    if (positionals.length > 1) throw new Refusal("unexpected-argument", `bun mcp dev takes one MCP; it was given ${positionals.join(", ")}`, usage)
    const root = findRoot(io.cwd)
    const mcp = await resolveMcp(root, io.cwd, positionals[0], "bun mcp dev <mcp>")
    const { name } = mcp
    const { env, settings } = await readSettings(root)
    const manifest = await manifestOf(root, name)
    const mounts = await declarations(root)
    const again = `bun mcp dev ${name}`
    const { problems, token, organisation, clientId, clientSecret } = await preflight(io, mcp, settings, manifest !== undefined)
    if (problems.length) throw refusal(problems, again)
    const signal = io.interrupt()
    const call = adminCall(io.fetch, token!)
    const started: Running[] = []
    const alone = `${local.toolbox}/${name}/mcp`
    const addresses = [...(mcp.serve === "standalone" ? [] : [local.toolboxResource]), ...(mcp.serve === "toolbox" ? [] : [alone])]
    const steps: Step[] = [
      {
        // Every MCP the Toolbox serves must have its schema and roles, or it refuses to start; and its own database its tables.
        name: "database", fix: again,
        run: async () => {
          for (const { name: mounted } of mounts) await sh(io, [process.execPath, cli, "db", mounted, "migrate"], root, env)
          await sh(io, [process.execPath, "run", "db:migrate"], join(root, toolbox.workspace), env)
          return `schemas ${listed(mounts.map(mounted => mounted.name), "and")}; the database of ${toolbox.name}`
        },
      },
      {
        name: "toolbox", fix: again,
        run: async () => {
          const [id, secret] = toolbox.client
          await startToolbox(io, root, name, { ...env, [id]: clientId, [secret]: clientSecret }, started)
          return `serving ${name} at ${addresses.join(" and ")}`
        },
      },
      ...(mcp.serve !== "toolbox" ? [
        {
          name: "register", fix: again,
          run: async () => {
            const registrar = createRegistrar(call)
            await registerStandalone(registrar, { name, scopes: scopesOf(manifest!) })
            return `${alone} and claude-code-${name}: ${counts(registrar)}`
          },
        },
        { name: "access", fix: again, run: async () => `organisation ${settings.MCP_DEV_ORGANISATION}: ${await giveStandaloneAccess(call, organisation!, name)}` },
      ] : []),
      ...(mcp.serve !== "standalone" ? [{ name: "enable", fix: again, run: async () => `organisation ${settings.MCP_DEV_ORGANISATION}: ${await enableInToolbox(io, call, { clientId, clientSecret }, organisation!, name)}` }] : []),
    ]
    let code: number
    try {
      code = await runSteps(io, false, steps, () => [])
      if (code === 0) code = await running(io, signal, started, mcp, settings.MCP_DEV_ORGANISATION)
    } finally {
      for (const server of started.toReversed()) await server.stop()
    }
    return code
  },
}

// Print what to do next, then wait for Ctrl-C or for the Toolbox to stop; 0 after Ctrl-C, 1 after the Toolbox stopped.
async function running(io: Io, signal: AbortSignal, started: readonly Running[], { name, serve }: Declaration, organisation: string) {
  const claude = (connection: string, url: string, client: string) => `  claude mcp add --transport http ${connection} ${url} --client-id ${client} --callback-port ${local.callbackPort}`
  const alone = `${local.toolbox}/${name}/mcp`
  const blocks = [
    ...(serve === "standalone" ? [] : [`${name} runs in the Toolbox at ${local.toolboxResource}, as the tools ${name}_*.\n\n${claude("answerable-toolbox", local.toolboxResource, "claude-code-toolbox")}\n\nIn Claude Code, run /mcp, choose answerable-toolbox, then Authenticate.\nEnabling ${name} for organisation ${organisation} and granting it to everyone there are local conveniences: in staging and production, staff do both (toolbox_enable and access_grant in the admin MCP).`]),
    ...(serve === "toolbox" ? [] : [`${name} runs at ${alone}\n\n${claude(name, alone, `claude-code-${name}`)}\n\nIn Claude Code, run /mcp, choose ${name}, then Authenticate.`]),
  ]
  io.stdout.write(`\n${blocks.join("\n\n")}\n\nCtrl-C stops ${toolbox.name}; an edit to ${name} reloads it.\n`)
  const interrupted = new Promise<"interrupted">(resolve => (signal.aborted ? resolve("interrupted") : signal.addEventListener("abort", () => resolve("interrupted"), { once: true })))
  const ended = await Promise.race([interrupted, ...started.map(server => server.exited)])
  if (ended === "interrupted") return (io.stdout.write(`\nStopping ${toolbox.name}.\n`), 0)
  io.stderr.write(`\n${toolbox.name} stopped with exit code ${ended}; its output above says why. Run bun mcp dev ${name} again.\n`)
  return 1
}
