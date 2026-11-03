import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import images from "../images.json"

// Images are built only on a tag (deploy-staging.yml), never by ci.yml, so a Dockerfile that forgets a COPY line fails
// when the owner ships. This reads each image's Dockerfile and the manifests it installs, and fails here instead.

const root = new URL("../../../", import.meta.url).pathname

type Manifest = { name: string; dependencies?: Record<string, string> }
type Workspace = { directory: string; manifest: Manifest }

/**
 * Declared dependencies a Dockerfile leaves out on purpose. The ops image copies no packages/mcp, and so no packages/auth,
 * which only that one needs: mcp-postgres declares @answerable/mcp but imports it as types, which Bun strips (the
 * Dockerfile says so). The last test proves it still holds: the ops entry bundles with both left out and never names them.
 */
const leftOut: Record<string, string[]> = { "infra/ops/Dockerfile": ["@answerable/mcp"] }

/** Every workspace of the repository, by package name, from the root package.json's `workspaces`. */
async function workspaces() {
  const { workspaces: patterns } = (await Bun.file(`${root}package.json`).json()) as { workspaces: string[] }
  const all = new Map<string, Workspace>()
  for (const pattern of patterns) {
    for await (const file of new Glob(`${pattern}/package.json`).scan({ cwd: root })) {
      const manifest = (await Bun.file(`${root}${file}`).json()) as Manifest
      all.set(manifest.name, { directory: file.replace(/\/package\.json$/, ""), manifest })
    }
  }
  return all
}

/** The workspaces a Dockerfile installs: each `bun install ... --filter <name or path glob>`, name or './mcps/*'. */
function installed(dockerfile: string, all: Map<string, Workspace>) {
  const filters = [...dockerfile.matchAll(/bun install[^\n]*?--filter\s+(?:'([^']+)'|"([^"]+)"|(\S+))/g)].map(
    (match) => match[1] ?? match[2] ?? match[3]!,
  )
  const chosen = [...all.values()].filter(({ directory, manifest }) =>
    filters.some((filter) =>
      filter.startsWith(".") ? new Glob(filter.replace(/^\.\//, "")).match(directory) : filter === manifest.name,
    ),
  )
  return { filters, chosen }
}

/**
 * The directories a Dockerfile copies from the build context: the sources of each COPY without --from. `COPY . .` is
 * left out on purpose: it is the manifests stage's, where every file but the manifests is deleted again.
 */
function copied(dockerfile: string) {
  return dockerfile
    .split("\n")
    .flatMap((line) => {
      const copy = line.match(/^COPY\s+(.+)$/)?.[1]
      if (copy === undefined || copy.includes("--from=")) return []
      return copy.split(/\s+/).filter((word) => !word.startsWith("--")).slice(0, -1)
    })
    .map((source) => source.replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((source) => source !== "." && source !== "")
}

/**
 * Every workspace the installed ones need to run: themselves and each `workspace:*` entry under `dependencies`, followed
 * through the dependencies of the packages found. Value is who needed it first.
 */
function needed(chosen: Workspace[], all: Map<string, Workspace>, skip: string[] = []) {
  const reached = new Map<string, string>(chosen.map(({ manifest }) => [manifest.name, "the install's --filter"]))
  const queue = [...chosen]
  for (let workspace = queue.shift(); workspace; workspace = queue.shift()) {
    for (const [name, specifier] of Object.entries(workspace.manifest.dependencies ?? {})) {
      if (!specifier.startsWith("workspace:") || reached.has(name) || skip.includes(name)) continue
      reached.set(name, workspace.manifest.name)
      queue.push(all.get(name)!)
    }
  }
  return reached
}

describe("every image's Dockerfile copies the workspaces it installs", () => {
  for (const { name, dockerfile: path } of images) {
    test(`${name}: ${path}`, async () => {
      const all = await workspaces()
      const dockerfile = await Bun.file(`${root}${path}`).text()
      const { filters, chosen } = installed(dockerfile, all)
      expect(chosen.length, `${path} installs no workspace: no \`bun install --filter\` names one`).toBeGreaterThan(0)
      const sources = copied(dockerfile)
      const missing = [...needed(chosen, all, leftOut[path])].flatMap(([workspace, by]) => {
        const { directory } = all.get(workspace)!
        const covered = sources.some((source) => directory === source || directory.startsWith(`${source}/`))
        return covered ? [] : [`${path} has no "COPY ${directory} ${directory}" for ${workspace} (needed by ${by}; --filter ${filters.join(", ")})`]
      })
      expect(missing).toEqual([])
    })
  }
})

describe("what a Dockerfile leaves out is never loaded", () => {
  test("ops: the entry bundles with packages/mcp and packages/auth external and names neither", async () => {
    const path = "infra/ops/Dockerfile"
    const all = await workspaces()
    const dockerfile = await Bun.file(`${root}${path}`).text()
    const { chosen } = installed(dockerfile, all)
    const copiedNames = [...needed(chosen, all, leftOut[path])].map(([name]) => name)
    const absent = [...needed(chosen, all)].map(([name]) => name).filter((name) => !copiedNames.includes(name))
    expect(absent).toEqual(["@answerable/mcp", "@answerable/auth"])
    // Once the Dockerfile copies one, the entry above is stale: delete it.
    expect(copied(dockerfile).filter((source) => absent.some((name) => all.get(name)!.directory === source))).toEqual([])
    const built = await Bun.build({ entrypoints: [`${root}infra/ops/src/cli.ts`], target: "bun", external: absent })
    expect(built.success).toBe(true)
    const bundle = await built.outputs[0]!.text()
    for (const name of absent) expect(bundle, name).not.toMatch(new RegExp(`["']${name}["'/]`))
  })
})
