// The one place the declared MCPs become data for the deployment: charts/answerable/mcps.json, from every mcps/*/mcp.json and manifest.
// bun mcp new, add tool and check write it; generate.test.ts fails when the committed file differs. Never edit it by hand.
import { join } from "node:path"
import { declarations, manifestOf } from "./workspace"

/** The file the chart reads, with an object root: Helm's `fromJson` turns an array into an error map. */
const chartList = "charts/answerable/mcps.json"

/** Every generated file's text, by path: for each declared MCP, where it runs, its database mode, its scopes and its grant strings. */
export async function generatedFiles(root: string): Promise<Record<string, string>> {
  const mcps = await Promise.all((await declarations(root)).map(async ({ name, serve, database }) => {
    const manifest = await manifestOf(root, name)
    const definitions = manifest ? [...manifest.tools, ...manifest.prompts, ...manifest.resources] : []
    const capabilities = manifest?.tools.filter(tool => tool.kind !== "commit").map(tool => tool.identity) ?? []
    const grants = manifest ? [name, ...capabilities.map(identity => identity.split(".")[0]!), ...capabilities] : []
    return { name, serve, database, scopes: [...new Set(definitions.flatMap(item => item.scopes))].sort(), grants: [...new Set(grants)].sort() }
  }))
  const list = { $comment: "Written by bun mcp from mcps/*/mcp.json and each manifest.json (scripts/mcp/generate.ts); never edit it by hand", mcps }
  return { [chartList]: `${JSON.stringify(list, null, 2)}\n` }
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
