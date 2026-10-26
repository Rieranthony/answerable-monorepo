// The one place the declared MCPs become data for the Toolbox and the deployment, from every mcps/*/mcp.json and manifest:
// - charts/answerable/mcps.json, the chart's list;
// - mcps/toolbox/src/mounted.generated.ts, every MCP the Toolbox serves, in its hub, alone at /<name>/mcp, or both;
// - the dependencies of mcps/toolbox/package.json, on the workspaces of those MCPs.
// bun mcp new, add tool and check write them; generate.test.ts fails when a committed file differs. Never edit them by hand.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { json } from "./templates/workspace"
import { reservedNames } from "./rules"
import { declarations, manifestOf, type Declaration, type Manifest } from "./workspace"

/** The file the chart reads, with an object root: Helm's `fromJson` turns an array into an error map. */
const chartList = "charts/answerable/mcps.json"

/** The Toolbox's workspace and its list, which every MCP is in. */
const toolbox = { workspace: "mcps/toolbox", list: "mcps/toolbox/src/mounted.generated.ts" }

// An MCP's workspace is @answerable/mcp-<name>.
const prefix = "@answerable/mcp-"
const packageOf = (name: string) => `${prefix}${name}`

// The Toolbox's list: each MCP, its provider imported from its workspace, where it is served, and where its tables live; an own MCP's, from the
// variable named here, such as TOOLBOX_MCP_ACME_DATABASE_URL.
function listOf(mcps: readonly Declaration[]) {
  const variable = (name: string) => `TOOLBOX_MCP_${name.toUpperCase()}_DATABASE_URL`
  const entries = mcps.map(({ name, serve, database }) => `  { provider: ${name}Provider, serve: "${serve}", database: "${database}"${database === "own" ? `, variable: "${variable(name)}"` : ""} },`)
  return [
    "// Written by bun mcp from mcps/*/mcp.json (scripts/mcp/generate.ts): every MCP the Toolbox serves, in its hub, alone, or both. Never edit it by hand.",
    `import type { Declared } from "@answerable/mcp-platform"`,
    ...mcps.map(({ name }) => `import { provider as ${name}Provider } from "${packageOf(name)}/provider"`),
    "",
    "/** The MCPs the Toolbox serves: each provider, where it is served, and where its tables live. */",
    `export const mounted: readonly Declared[] = [${entries.length ? `\n${entries.join("\n")}\n` : ""}]`,
    "",
  ].join("\n")
}

// The Toolbox's package.json with a dependency on the workspace of every MCP, and on no other MCP's. A reserved name is never an MCP's, so the
// platform's own packages, such as @answerable/mcp-platform, stay.
async function packageJsonOf(path: string, served: readonly Declaration[]) {
  const file = await Bun.file(path).json() as { dependencies: Record<string, string> }
  const kept = Object.entries(file.dependencies).filter(([dependency]) => !dependency.startsWith(prefix) || reservedNames.includes(dependency.slice(prefix.length)))
  file.dependencies = Object.fromEntries([...kept, ...served.map(({ name }) => [packageOf(name), "workspace:*"])].sort(([a], [b]) => (a! < b! ? -1 : 1)))
  return json(file)
}

/** The scopes a manifest's tools, prompts and resources ask for, sorted: those of the MCP's resource in ID, `offline_access` aside. */
export const scopesOf = (manifest: Manifest) => [...new Set([...manifest.tools, ...manifest.prompts, ...manifest.resources].flatMap(item => item.scopes))].sort()

/** Every generated file's text, by path. The Toolbox's list and dependencies are written only where its workspace is. */
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
  if (existsSync(join(root, toolbox.workspace, "package.json"))) {
    files[toolbox.list] = listOf(declared)
    files[`${toolbox.workspace}/package.json`] = await packageJsonOf(join(root, toolbox.workspace, "package.json"), declared)
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
