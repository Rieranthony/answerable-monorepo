// Every file bun mcp writes, by path, from pure functions: the docs render exactly these (apps/web/components/docs/generated.tsx), and
// mcps/example is exactly what they write for it (templates.test.ts).
import { toolPath, type Answers, type ToolAnswers } from "./names"
import { mcpTs, providerTest, providerTs, schemaTs, withTool } from "./sources"
import { toolTest, toolTs } from "./tool"
import { bunfig, eslintConfig, mcpJson, packageJson, tsconfig } from "./workspace"

export { importedBindings, schemaBinding, toolBinding, toolPath, wireName } from "./names"
export type { Answers, DatabaseMode, Serve, ToolAnswers } from "./names"
export { tableTs, toolsMarker, withTool } from "./sources"

/** A tool's file and its test, by path. */
export function toolFiles(name: string, tool: ToolAnswers): Record<string, string> {
  const path = toolPath(tool.name)
  return { [path]: toolTs(name, tool), [path.replace(/\.ts$/, ".test.ts")]: toolTest(tool) }
}

/**
 * Every file of a new MCP, by path, with its first tool added as `bun mcp add tool` adds one when `tool` is given: the manifest and the first
 * migration come later, from the first test run and drizzle-kit.
 */
export function mcpFiles(answers: Answers): Record<string, string> {
  const files: Record<string, string> = {
    "mcp.json": mcpJson(answers),
    "package.json": packageJson(answers),
    "tsconfig.json": tsconfig(),
    "eslint.config.mjs": eslintConfig(),
    "bunfig.toml": bunfig(),
    "src/mcp.ts": mcpTs(),
    "src/provider.ts": providerTs(answers),
    "src/provider.test.ts": providerTest(),
    "src/db/schema.ts": schemaTs(answers),
  }
  if (!answers.tool) return files
  const { provider, schema } = withTool(answers.name, { provider: files["src/provider.ts"]!, schema: files["src/db/schema.ts"]! }, answers.tool)
  return { ...files, "src/provider.ts": provider, "src/db/schema.ts": schema, ...toolFiles(answers.name, answers.tool) }
}
