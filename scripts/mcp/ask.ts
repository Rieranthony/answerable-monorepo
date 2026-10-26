// The questions bun mcp asks in a terminal, each with its rule and an example, checked as the flags are. Cancelling writes nothing.
import { Refusal, type Io, type Problem } from "./io"
import { toolDescriptionProblem, toolNameProblem } from "./rules"

/** The refusal of a cancelled prompt, with the command to run instead. */
export const cancelled = (command: string) => new Refusal("cancelled", "Cancelled: nothing was written", command)

/** Ask a line of text, checked by `problem`. With `optional`, Enter answers `undefined`. `command` is what a cancel prints to run instead. */
export async function ask(io: Io, command: string, message: string, problem: (value: string) => Problem | undefined, { placeholder, optional = false }: { placeholder?: string; optional?: boolean } = {}) {
  const answer = await io.prompts.text({
    message, placeholder, input: io.stdin, output: io.stdout,
    validate: value => (optional && !value ? undefined : problem(value ?? "")?.message),
  })
  if (typeof answer === "symbol") throw cancelled(command)
  return answer || undefined
}

/** Choose one of `options`; the first is the default an Enter takes. */
export async function choose<Value extends string>(io: Io, command: string, message: string, options: { value: Value; label: string; hint: string }[]): Promise<Value> {
  const answer = await io.prompts.select<Value>({ message, options: options as Parameters<typeof io.prompts.select<Value>>[0]["options"], initialValue: options[0]!.value, input: io.stdin, output: io.stdout })
  if (typeof answer === "symbol") throw cancelled(command)
  return answer
}

const describe = (tool: string) =>
  `What does ${tool} do? Say when to use it and its limits, in 40 to 1,000 characters. Good: "List the notes of a project, newest first, 20 per page. Use projects.search first to find the project id." Bad: "Gets notes."`

/** Ask a tool's description; a mutation's must also say that it prepares an intent. */
export async function askToolDescription(io: Io, command: string, mcp: string, tool: string, mutation: boolean) {
  const rule = mutation ? ` A change's description says that it prepares an intent: use the word "prepare" or "intent".` : ""
  return (await ask(io, command, `${describe(tool)}${rule}`, value => toolDescriptionProblem(mcp, tool, value, mutation)))!
}

/**
 * Ask for a tool of MCP `mcp`, in the design's order: its name, its description unless `description` is given, then read or change unless
 * `mutation` was given. With `optional`, Enter skips the tool and answers `undefined`. A change whose description does not say it prepares an
 * intent is asked for its description again.
 */
export async function askTool(io: Io, command: string, { mcp, root, identities, optional, ...given }: {
  mcp: string; root: string; identities: readonly string[]; optional: boolean; description?: string; mutation?: true
}) {
  const skip = optional ? " Enter skips it: the MCP starts with no tool." : ""
  const message = `${optional ? "First tool" : "Tool"}, <domain>.<operation>: what the caller can do, such as notes.list or projects.search; never the vendor or the transport.${skip}`
  const name = await ask(io, command, message, value => toolNameProblem(mcp, value, root, identities), { placeholder: "notes.list", optional })
  if (!name) return undefined
  let description = given.description ?? await askToolDescription(io, command, mcp, name, given.mutation ?? false)
  const mutation = given.mutation ?? (await choose(io, command, "Read or change?", [
    { value: "read", label: "Read", hint: "answers a question and changes nothing" },
    { value: "change", label: "Change", hint: "prepared first, then committed (--mutation)" },
  ])) === "change"
  if (mutation && toolDescriptionProblem(mcp, name, description, true)) description = await askToolDescription(io, command, mcp, name, true)
  return { name, description, mutation }
}
