// The rules bun mcp checks before it writes anything. Each is the SDK's own where the SDK has one, and each problem has a stable code.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { checkDescription, checkMutationDescription, checkProviderId, checkToolName } from "@answerable/mcp"
import { importedBindings, toolBinding, toolPath, wireName } from "./templates"

import type { Problem } from "./io"

/**
 * Names no MCP may take: the platform's own services, hosts and schemas, and the names whose workspace, `@answerable/mcp-<name>`, would be one of
 * the platform's packages (`platform`, `postgres`). `e2e` and `example` are taken by their directories.
 */
const reservedNames = ["toolbox", "admin", "id", "mcp", "mcps", "standalone", "api", "www", "test", "ops", "public", "drizzle", "platform", "postgres"]

/** The values of `--serve` and `--database`, the default first where there is one. */
export const choices = { serve: ["toolbox", "standalone", "both"], database: ["shared", "own"] } as const

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
