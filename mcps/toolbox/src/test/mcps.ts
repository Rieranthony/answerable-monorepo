// The MCPs the Toolbox serves, as its tests serve them, read from the generated list so that a new MCP needs no edit here: the shared ones in
// a shared MCP database of this suite's own, answerable_toolbox_test_mcps, under the role prefix mcp_tbx, and each own one in a database of its
// own, answerable_toolbox_test_<name>; all made once for the run and dropped after it (src/test/preload.ts).
import { mcpDatabases, type Declared } from "@answerable/mcp-platform"
import { testOwnMcp, testSharedMcps } from "@answerable/mcp-platform/testing"
import { mounted } from "../mounted.generated"

type Own = Extract<Declared, { database: "own" }>

export const prefix = "mcp_tbx"
export const databases = await testSharedMcps({ name: "answerable_toolbox_test_mcps", prefix, mcps: mounted.filter(entry => entry.database === "shared").map(entry => entry.provider) })
const owned = await Promise.all(mounted.filter((entry): entry is Own => entry.database === "own")
  .map(async entry => ({ entry, database: await testOwnMcp({ name: `answerable_toolbox_test_${entry.provider.id}`, provider: entry.provider }) })))
/** Each own MCP's variable, with its test database's URL, as the entry point reads them. */
export const ownUrls: Readonly<Record<string, string>> = Object.fromEntries(owned.map(({ entry, database }) => [entry.variable, database.url]))
export const opened = mcpDatabases(mounted, { shared: databases.url, own: ownUrls, prefix })
/** What `/health` answers with every MCP's database up: the Toolbox's database, the shared MCP database and each own one, then every MCP it serves. */
export const healthy = {
  status: "ok",
  databases: Object.fromEntries([["toolbox", "ok"], ["mcps", "ok"], ...owned.map(({ entry }) => [entry.provider.id, "ok"])]),
  providers: mounted.map(entry => entry.provider.id).toSorted(),
}
/** Drop every own MCP's test database. */
export const closeOwn = () => Promise.all(owned.map(({ database }) => database.close()))
/** The mounted e2e provider, with its db. */
export const e2e = opened.mount.find(entry => entry.provider.id === "e2e")!
