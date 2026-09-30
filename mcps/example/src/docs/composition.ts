// A snippet the docs include: typechecked and linted with this server, never served.
import { defineTool, type Tool } from "@answerable/mcp"

// A tool is data, so ordinary code wraps it: this one logs every call.
export function audited(tool: Tool, log: (line: string) => void): Tool {
  return defineTool({
    ...tool,
    async execute(input, context) {
      log(`${context.principal.userId} ${tool.name} ${context.executionId}`)
      return tool.execute(input, context)
    },
  })
}
