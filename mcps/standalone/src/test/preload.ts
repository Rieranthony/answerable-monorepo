import { afterAll } from "bun:test"
import { databases } from "./mcps"

// The suite's MCP database lasts the whole run, and goes with it.
afterAll(() => databases.close())
