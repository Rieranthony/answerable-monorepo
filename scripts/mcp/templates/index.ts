// Every file bun mcp writes, by path, from pure functions: the docs render exactly these (apps/web/components/docs/generated.tsx).
import { toolPath, type Answers, type ToolAnswers } from "./names"
import { mcpTs, providerTest, providerTs, schemaTs } from "./sources"
import { toolTest, toolTs } from "./tool"
import { bunfig, eslintConfig, mcpJson, packageJson, readme, tsconfig } from "./workspace"

export { importedBindings, schemaBinding, toolBinding, toolModule, toolPath, wireName } from "./names"
export type { Answers, DatabaseMode, Serve, ToolAnswers } from "./names"
export { isolationImport, tableTs, toolsMarker } from "./sources"

/** A tool's file and its test, by path; without `tool`, the status tool of MCP `name`. */
export function toolFiles(name: string, tool?: ToolAnswers): Record<string, string> {
  const path = toolPath(tool?.name ?? `${name}.status`)
  return { [path]: toolTs(name, tool), [path.replace(/\.ts$/, ".test.ts")]: toolTest(name, tool) }
}

/** Every file of a new MCP, by path: the manifest and the first migration come later, from the first test run and drizzle-kit. */
export function mcpFiles(answers: Answers): Record<string, string> {
  return {
    "mcp.json": mcpJson(answers),
    "package.json": packageJson(answers),
    "tsconfig.json": tsconfig(),
    "eslint.config.mjs": eslintConfig(),
    "bunfig.toml": bunfig(),
    "README.md": readme(answers),
    "src/mcp.ts": mcpTs(),
    "src/provider.ts": providerTs(answers),
    "src/provider.test.ts": providerTest(),
    "src/db/schema.ts": schemaTs(answers),
    ...toolFiles(answers.name, answers.tool),
  }
}
