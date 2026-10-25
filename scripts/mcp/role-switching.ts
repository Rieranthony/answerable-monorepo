// The trust boundary of the shared MCP database (docs/goals/mcp-cli/design.md, Database, Trust): a provider runs inside the process that
// serves it, whose login may take the runtime role of every MCP that process serves, so no MCP's code may switch role or set the caller's
// organisation. mcpDatabase does both on every borrow.
import { join } from "node:path"

const forbidden = /\b(?:set\s+(?:local\s+|session\s+)?role|reset\s+role|set\s+(?:local\s+|session\s+)?session\s+authorization|answerable\.organisation_id)\b/gi

/**
 * Scan the TypeScript files `pattern` matches under `root` (by default every MCP's `src`), generated files aside, for a role switch or the
 * organisation setting: the files scanned, and each place found as `path:line: text`, sorted.
 */
export async function roleSwitching(root: string, pattern = "mcps/*/src/**/*.ts"): Promise<{ files: number; found: string[] }> {
  const found: string[] = []
  let files = 0
  for await (const path of new Bun.Glob(pattern).scan({ cwd: root })) {
    if (path.endsWith(".generated.ts")) continue
    files += 1
    const text = await Bun.file(join(root, path)).text()
    for (const match of text.matchAll(forbidden)) found.push(`${path}:${text.slice(0, match.index).split("\n").length}: ${match[0]}`)
  }
  return { files, found: found.sort() }
}
