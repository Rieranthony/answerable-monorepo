// The files of an MCP's workspace around its code: its declaration, package, compiler, lint and test settings.
import type { Answers } from "./names"

/** The versions every MCP pins, the repository's own: a test fails when one differs from what the packages it shares use. */
export const pins = {
  dependencies: { "@answerable/mcp": "workspace:*", "@answerable/mcp-postgres": "workspace:*", "drizzle-orm": "0.45.4", zod: "4.6.7" },
  devDependencies: { "@eslint/js": "9.39.5", "@types/bun": "1.3.1", eslint: "9.39.5", typescript: "5.9.3", "typescript-eslint": "8.48.1" },
}

/** A JSON file as bun mcp writes one: two spaces, and a newline at the end. */
export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** `mcp.json`, the declaration: where the MCP runs and its database mode, which the generator turns into the deployment's list. */
export const mcpJson = ({ serve, database }: Answers) => json({ serve, database })

/** `package.json`: the workspace `@answerable/mcp-<name>`, its provider exported for the servers that mount it, and `bun mcp` from inside it. */
export const packageJson = ({ name }: Answers) => json({
  name: `@answerable/mcp-${name}`,
  version: "0.0.0",
  private: true,
  type: "module",
  exports: { "./provider": "./src/provider.ts" },
  scripts: { test: "bun test", typecheck: "tsc --noEmit", lint: "eslint src --max-warnings 0", mcp: "bun ../../scripts/mcp/cli.ts" },
  ...pins,
})

export const tsconfig = () => json({
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2023", "DOM"],
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    resolveJsonModule: true,
    types: ["bun"],
  },
  include: ["src/**/*.ts"],
})

export const eslintConfig = () => `import eslint from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["coverage/**"],
  },
)
`

/** `bunfig.toml`: the gate of 100% line and function coverage over `src`. */
export const bunfig = () => `[test]
root = "src"
coverage = true
coverageSkipTestFiles = true
coverageThreshold = { lines = 1, functions = 1 }
coverageReporter = ["text", "lcov"]
coveragePathIgnorePatterns = ["../**"]
`
