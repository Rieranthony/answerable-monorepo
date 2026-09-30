import { existsSync } from "node:fs"
import { join } from "node:path"
import { scaffoldSources } from "./mcp-templates"

const repo = new URL("../", import.meta.url).pathname
const e2e = join(repo, "mcps/e2e")
const pick = (from: Record<string, string>, names: string[]) => Object.fromEntries(names.map(name => [name, from[name]]))

/** Write `mcps/<name>`, a server with one tool, and return the commands that install it, write its manifest and check it. */
export async function scaffold(name: string, { root = repo, date = new Date().toISOString().slice(0, 10) } = {}) {
  if (!/^[a-z][a-z0-9]{0,11}$/.test(name)) throw new Error(`Server name "${name}" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme`)
  const dir = join(root, "mcps", name)
  if (existsSync(dir)) throw new Error(`mcps/${name} already exists; choose another name or remove it`)
  const pins = await Bun.file(join(e2e, "package.json")).json()
  const pkg = {
    name: `@answerable/mcp-${name}`,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: { dev: "bun --hot src/server.ts", start: "bun src/server.ts", test: "bun test", typecheck: "tsc --noEmit", lint: "eslint src --max-warnings 0" },
    dependencies: pick(pins.dependencies, ["@answerable/mcp", "zod"]),
    devDependencies: pick(pins.devDependencies, ["@eslint/js", "@types/bun", "eslint", "typescript", "typescript-eslint"]),
  }
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "tsconfig.json": await Bun.file(join(e2e, "tsconfig.json")).text(),
    "eslint.config.mjs": await Bun.file(join(e2e, "eslint.config.mjs")).text(),
    "bunfig.toml": await Bun.file(join(e2e, "bunfig.toml")).text(),
    ...scaffoldSources(name, date),
  }
  for (const [path, content] of Object.entries(files)) await Bun.write(join(dir, path), content)
  return `Created mcps/${name} (@answerable/mcp-${name}). Next, from the repository root:

  bun install
  UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-${name} test
  bun run mcp:check @answerable/mcp-${name}
`
}

if (import.meta.main) {
  try {
    console.log(await scaffold(Bun.argv[2] ?? ""))
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}
