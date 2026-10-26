// The rules bun mcp checks before it writes anything. Each is the SDK's own where the SDK has one, and each problem has a stable code.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { checkDescription, checkMutationDescription, checkProviderId, checkToolName } from "@answerable/mcp"
import type { Problem } from "./io"
import { importedBindings, toolBinding, toolPath, wireName } from "./templates"
import { declaration } from "./workspace"

/**
 * Names no MCP may take, each with its reason. `platform` and `postgres` matter to the generator too: a server keeps every dependency whose name,
 * `@answerable/mcp-<name>`, is reserved. `e2e` and `example` are taken by their directories.
 */
export const reservedNames = [
  "toolbox", // the Toolbox's own provider id, whose tools are toolbox_*, and its workspace, @answerable/mcp-toolbox
  "admin", // the admin MCP's workspace, @answerable/mcp-admin, and the Toolbox's admin resource, /admin
  "mcp", // the Toolbox serves its hub at /mcp and each standalone MCP at /<name>/mcp, by the path's first segment: mcp would take the hub's path
  "mcps", // the folder of every MCP, the mcps image and the shared database, answerable_mcps
  "standalone", // a value of --serve, which a person who types it as a name means: the refusal says so
  "id", // Answerable ID, the platform's identity service at id.<zone>; no collision since MCPs are served by path, but it reads as ID's
  "api", // ID's admin API, /api/admin; no collision on the Toolbox's origin, but it reads as the platform's API
  "www", // the site's host, www.<zone>; no collision since MCPs are served by path, but it reads as the site's
  "ops", // the deployment's ops Jobs and image (infra/ops); no collision since MCPs have their own workspace prefix, but it reads as theirs
  "test", // reads as a test fixture; it collided with the per-MCP test roles, which grants replaced (pull request 13, D-3)
  "public", // Postgres's default schema, which no MCP may touch
  "drizzle", // drizzle-kit's default schema for its journal
  "platform", // @answerable/mcp-platform
  "postgres", // @answerable/mcp-postgres
]

/** The values of `--serve` and `--database`, the default first where there is one. */
export const choices = { serve: declaration.shape.serve.options, database: declaration.shape.database.options }

/** An MCP's name: the provider id's rule, then not reserved, not retired (`retired`) and not taken by a directory of `mcps/` under `root`. */
export function nameProblem(name: string, root: string, retired: readonly string[]): Problem | undefined {
  const invalid = checkProviderId(name)
  if (invalid) return { code: "invalid-name", message: `MCP name ${invalid}` }
  if (reservedNames.includes(name)) {
    return { code: "name-reserved", message: `${name} is reserved; choose another name${name === "standalone" ? "; to serve your MCP on its own URL, pass --serve standalone" : ""}` }
  }
  if (retired.includes(name)) return { code: "name-retired", message: `${name} is retired (mcps/retired.json): a removed MCP's name is never used again; choose another name` }
  if (existsSync(join(root, "mcps", name))) return { code: "name-taken", message: `${name} is taken by mcps/${name}; choose another name` }
}

/** An MCP's description: the SDK's rule, 40 to 1,000 characters. */
export function descriptionProblem(description: string): Problem | undefined {
  const problem = checkDescription(description)
  if (problem) return { code: "invalid-description", message: `An MCP's description ${problem}` }
}

/** `a, b or c` with `or`, `a, b and c` with `and`; one value alone. */
export const listed = (values: readonly string[], word: "or" | "and") => (values.length < 2 ? values.join("") : `${values.slice(0, -1).join(", ")} ${word} ${values.at(-1)}`)

/** A value of `--serve` or `--database`: exactly one of its choices. */
export function choiceProblem(flag: keyof typeof choices, value: string): Problem | undefined {
  const allowed: readonly string[] = choices[flag]
  if (!allowed.includes(value)) return { code: `invalid-${flag}`, message: `--${flag} must be ${listed(allowed, "or")}, not "${value}"` }
}

/**
 * A tool's name in MCP `mcp`: the SDK's rule; never a binding its files import; and, once `mcp` is a valid name, never a commit tool's name on
 * the wire, served alone or in the Toolbox, and new to the MCP, which `identities` (its manifest's) and the tool's file under `root` say.
 */
export function toolNameProblem(mcp: string | undefined, tool: string, root: string, identities: readonly string[]): Problem | undefined {
  const invalid = checkToolName(tool)
  if (invalid) return { code: "invalid-tool-name", message: `Tool name ${invalid}` }
  if (importedBindings.includes(toolBinding(tool))) {
    return { code: "tool-name-reserved", message: `${tool} would be exported as ${toolBinding(tool)}, a name the MCP's files import; choose another name` }
  }
  if (mcp === undefined) return
  const wire = [wireName(tool), `${mcp}_${wireName(tool)}`].find(name => name === `${mcp}_commit` || name === `${mcp}_commit_confirmed`)
  if (wire) return { code: "tool-name-reserved", message: `${tool} would be called ${wire}, the name of ${mcp}'s commit tool; choose another name` }
  const path = `mcps/${mcp}/${toolPath(tool)}`
  if (existsSync(join(root, path))) return { code: "tool-exists", message: `${mcp} has a tool ${tool}: ${path}; choose another name` }
  if (identities.includes(`${mcp}/${tool}`)) return { code: "tool-exists", message: `${mcp} has a tool ${tool}: mcps/${mcp}/manifest.json lists it; choose another name` }
}

/** A tool's description: the SDK's rule, and for a mutation the conformance kit's, with its message. */
export function toolDescriptionProblem(mcp: string, tool: string, description: string, mutation: boolean): Problem | undefined {
  const problem = checkDescription(description)
  if (problem) return { code: "invalid-tool-description", message: `A tool's description ${problem}` }
  const prepares = mutation ? checkMutationDescription(description) : undefined
  if (prepares) return { code: "mutation-description", message: `${mcp}/${tool}: a mutation's description ${prepares}` }
}
