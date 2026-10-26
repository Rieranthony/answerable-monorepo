// The files of an MCP's workspace around its code: its declaration, package, compiler, lint and test settings, and README.
import type { Answers } from "./names"

/** The versions every MCP pins, the repository's own: a test fails when one differs from what the packages it shares use. */
export const pins = {
  dependencies: { "@answerable/mcp": "workspace:*", "@answerable/mcp-postgres": "workspace:*", "drizzle-orm": "0.45.4", zod: "4.6.7" },
  devDependencies: { "@eslint/js": "9.39.5", "@types/bun": "1.3.1", eslint: "9.39.5", typescript: "5.9.3", "typescript-eslint": "8.48.1" },
}

/** A JSON file as bun mcp writes one: two spaces, and a newline at the end. */
export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** `mcp.json`, the declaration: where the MCP runs and its database mode, which the generator turns into the deployment's list. */
export const mcpJson = ({ name, serve, database }: Answers) => json({ $schema: "../../scripts/mcp/mcp.schema.json", name, serve, database })

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

const docs = "../../apps/web/content/docs"

// Where it runs: the Toolbox serves it, in its hub, at its own path or both, from the list bun mcp generates from mcp.json.
const placements = (name: string) => ({
  toolbox: `in the Toolbox, which mounts it from \`mcps/toolbox/src/mounted.generated.ts\`; hosts call its tools \`${name}_<domain>_<operation>\` at the Toolbox's one URL, \`http://localhost:47400/mcp\` locally (\`bun run toolbox:dev\`)`,
  standalone: `on its own URL, \`/${name}/mcp\`, which the Toolbox serves from the same list: \`http://localhost:47400/${name}/mcp\` locally`,
})

/** `README.md`: what the MCP is, where it runs, its database, its commands, and the guides. */
export function readme({ name, description, serve, database }: Answers) {
  const placement = placements(name)
  const where = serve === "both" ? `both ${placement.toolbox}; and ${placement.standalone}` : placement[serve]
  const tables = database === "shared" ? `in schema \`${name}\` of the shared database \`answerable_mcps\`` : `in schema \`${name}\` of its own database, \`answerable_mcp_${name}\``
  return `# ${name} MCP

${description}

- **Where it runs** (\`"serve": "${serve}"\` in \`mcp.json\`): ${where}.
- **Its tables** (\`"database": "${database}"\`): ${tables}, each limited to the caller's organisation by Postgres. Its tests use schema \`${name}\` of \`answerable_mcps_test\`.
- **Its tools:** one file each in \`src/tools\`, with its test, listed in \`src/provider.ts\`. \`manifest.json\` is their contract.

\`\`\`sh
bun mcp add tool ${name} <domain.operation> --description "<what it does, when to use it, its limits>"
bun mcp check ${name}
bun mcp db ${name} generate
bun mcp db ${name} migrate
\`\`\`

Run them from the repository root, or from \`mcps/${name}\` without the name. \`add tool\` writes a read tool, or with \`--mutation\` a change, with its test and its table, then checks the MCP. \`check\` runs the typecheck, the lint and the tests, with [the conformance kit](${docs}/mcp/testing.mdx) and a 100% coverage gate; it rewrites a stale \`manifest.json\` and says to commit it. After a change to \`src/db/schema.ts\`, \`db generate\` writes the migration into \`drizzle/\`: review and commit it. \`db migrate\` migrates the local development schema. \`bun mcp\` writes \`mcp.json\`; change \`serve\` and \`database\` there.

Guides: [Make an MCP](${docs}/mcp/create.mdx), [Add a tool](${docs}/mcp/add-a-tool.mdx), [Your MCP's database](${docs}/mcp/database.mdx), [Sign-in](${docs}/mcp/sign-in.mdx), [Ship it](${docs}/mcp/deploy.mdx), [Test an MCP](${docs}/mcp/testing.mdx).
`
}
