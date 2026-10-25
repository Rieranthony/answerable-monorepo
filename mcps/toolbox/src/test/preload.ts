import { afterAll } from "bun:test"
import { databases, opened } from "./mcps"

// The suite's MCP database lasts the whole run, and goes with it.
afterAll(async () => {
  await opened.close()
  await databases.close()
})
