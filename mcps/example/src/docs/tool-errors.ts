// A snippet the docs include: typechecked and linted with this server, never served.
import { ToolError } from "@answerable/mcp"

// Throw one of these from execute, prepare or commit when a call fails in a way you expect.
export const refusals = [
  new ToolError("NOT_FOUND", "No accessible note exists"),
  new ToolError("RATE_LIMITED", "Try again shortly", { retry: { policy: "after_delay", after_ms: 30_000 } }),
  new ToolError("PRECONDITION_FAILED", "The note is locked", { details: { preconditions: ["unlocked"] } }),
]
