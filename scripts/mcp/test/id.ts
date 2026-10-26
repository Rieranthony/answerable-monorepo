// Test support for the commands that talk to the local ID: Answerable ID in memory (the fake of @answerable/id-admin), and a process environment that
// holds none of the developer's own variables.
import { createFakeId } from "@answerable/id-admin/testing"
import { afterEach, beforeEach } from "bun:test"

/** The local ID's root secret when .env sets none: ID's development default. */
const rootSecret = "development-only-root-admin-secret-never-for-production"

/** A local ID in memory, at the address the local ID has, with its platform organisation `answerable` unless `platform` is false, whose root secret is `rootSecret`. */
export const localId = ({ platform = true } = {}) => createFakeId({ rootSecret, issuer: "http://localhost:47300", platform })
export type LocalId = ReturnType<typeof localId>

/** The writes ID received, as `METHOD /path`. */
export const writesTo = (id: LocalId) => id.received.filter(({ request }) => !request.startsWith("GET")).map(({ request }) => request.replace("/api/admin/v1", ""))

const variables = ["ROOT_ADMIN_SECRET", "MCP_DEV_ID_CLIENT_ID", "MCP_DEV_ID_CLIENT_SECRET", "MCP_DEV_ORGANISATION", "MCPS_DATABASE_ADMIN_URL", "TOOLBOX_ID_CLIENT_ID", "TOOLBOX_ID_CLIENT_SECRET"]

/** Until each test ends, the process environment holds none of the variables bun mcp reads or sets, whatever the developer exported. */
export function isolateEnvironment() {
  let kept: Record<string, string | undefined> = {}
  beforeEach(() => {
    kept = Object.fromEntries(variables.map(name => [name, process.env[name]]))
    for (const name of variables) delete process.env[name]
  })
  afterEach(() => {
    for (const [name, value] of Object.entries(kept)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}
