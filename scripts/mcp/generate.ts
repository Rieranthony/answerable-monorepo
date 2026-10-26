// The one place the declared MCPs become data for the servers and the deployment, from every mcps/*/mcp.json and manifest:
// - charts/answerable/mcps.json, the chart's list;
// - mcps/toolbox/src/mounted.generated.ts and mcps/standalone/src/served.generated.ts, the MCPs each server serves;
// - the dependencies of mcps/toolbox/package.json and mcps/standalone/package.json, on the workspaces of those MCPs.
// bun mcp new, add tool and check write them; generate.test.ts fails when a committed file differs. Never edit them by hand.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { declarations, manifestOf, retired, type Declaration, type Manifest } from "./workspace"

/** The file the chart reads, with an object root: Helm's `fromJson` turns an array into an error map. */
const chartList = "charts/answerable/mcps.json"

/** The two servers that serve MCPs: the workspace, its list's file and binding, the `serve` values it takes and the prefix of its variables. */
const servers = [
  { workspace: "mcps/toolbox", list: "src/mounted.generated.ts", binding: "mounted", serves: ["toolbox", "both"], variables: "TOOLBOX", what: "the Toolbox mounts" },
  { workspace: "mcps/standalone", list: "src/served.generated.ts", binding: "served", serves: ["standalone", "both"], variables: "STANDALONE", what: "the standalone server serves" },
] as const
type Server = (typeof servers)[number]

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const packageOf = (name: string) => `@answerable/mcp-${name}`

// A server's list: each MCP it serves, its provider imported from its workspace, and where its tables live; an own MCP's, from the variable
// named here, such as TOOLBOX_MCP_ACME_DATABASE_URL.
function listOf(server: Server, mcps: readonly Declaration[]) {
  const variable = (name: string) => `${server.variables}_MCP_${name.toUpperCase()}_DATABASE_URL`
  const entries = mcps.map(({ name, database }) => `  { provider: ${name}Provider, database: "${database}"${database === "own" ? `, variable: "${variable(name)}"` : ""} },`)
  return [
    `// Written by bun mcp from mcps/*/mcp.json (scripts/mcp/generate.ts): every MCP ${server.what}, serve ${server.serves.join(" or ")}. Never edit it by hand.`,
    `import type { Declared } from "@answerable/mcp-platform"`,
    ...mcps.map(({ name }) => `import { provider as ${name}Provider } from "${packageOf(name)}/provider"`),
    "",
    `/** The MCPs ${server.what}: each provider, and where its tables live. */`,
    `export const ${server.binding}: readonly Declared[] = [${entries.length ? `\n${entries.join("\n")}\n` : ""}]`,
    "",
  ].join("\n")
}

// A server's package.json with a dependency on the workspace of every MCP it serves, and on no other MCP's, declared or retired.
async function packageJsonOf(path: string, served: readonly Declaration[], known: readonly string[]) {
  const file = await Bun.file(path).json() as { dependencies: Record<string, string> }
  const kept = Object.entries(file.dependencies).filter(([dependency]) => !known.some(name => dependency === packageOf(name)))
  file.dependencies = Object.fromEntries([...kept, ...served.map(({ name }) => [packageOf(name), "workspace:*"])].sort(([a], [b]) => (a! < b! ? -1 : 1)))
  return json(file)
}

/** The scopes a manifest's tools, prompts and resources ask for, sorted: those of the MCP's resource in ID, `offline_access` aside. */
export const scopesOf = (manifest: Manifest) => [...new Set([...manifest.tools, ...manifest.prompts, ...manifest.resources].flatMap(item => item.scopes))].sort()

/** Every generated file's text, by path. A server's list and dependencies are written only where its workspace is. */
export async function generatedFiles(root: string): Promise<Record<string, string>> {
  const declared = await declarations(root)
  const mcps = await Promise.all(declared.map(async ({ name, serve, database }) => {
    const manifest = await manifestOf(root, name)
    const capabilities = manifest?.tools.filter(tool => tool.kind !== "commit").map(tool => tool.identity) ?? []
    const grants = manifest ? [name, ...capabilities.map(identity => identity.split(".")[0]!), ...capabilities] : []
    return { name, serve, database, scopes: manifest ? scopesOf(manifest) : [], grants: [...new Set(grants)].sort() }
  }))
  const list = { $comment: "Written by bun mcp from mcps/*/mcp.json and each manifest.json (scripts/mcp/generate.ts); never edit it by hand", mcps }
  const files: Record<string, string> = { [chartList]: json(list) }
  const present = servers.filter(({ workspace }) => existsSync(join(root, workspace, "package.json")))
  const known = present.length ? [...declared.map(({ name }) => name), ...await retired(root)] : []
  for (const server of present) {
    const served = declared.filter(({ serve }) => (server.serves as readonly string[]).includes(serve))
    files[`${server.workspace}/${server.list}`] = listOf(server, served)
    files[`${server.workspace}/package.json`] = await packageJsonOf(join(root, server.workspace, "package.json"), served, known)
  }
  return files
}

/** The generated files that differ from what the generator writes now, by path; rewritten when `write` is set. */
export async function generate(root: string, { write }: { write: boolean }): Promise<string[]> {
  const stale: string[] = []
  for (const [path, text] of Object.entries(await generatedFiles(root))) {
    const file = Bun.file(join(root, path))
    if ((await file.exists()) && (await file.text()) === text) continue
    stale.push(path)
    if (write) await Bun.write(file, text)
  }
  return stale
}
