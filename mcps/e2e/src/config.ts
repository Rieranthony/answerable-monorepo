import { readMcpEnvironment } from "@answerable/mcp-base"
import { z } from "zod"

export function readConfig(env: Record<string, string | undefined>) {
  const shared = readMcpEnvironment(env)
  const recordsPath = z.string().min(1).safeParse(env.MCP_RECORDS_PATH)
  if (!recordsPath.success) throw new Error("Invalid MCP configuration: MCP_RECORDS_PATH is required")
  return { ...shared, recordsPath: recordsPath.data }
}
