/** A database `/health` checks: a `pg` pool, or anything that answers a query. */
export type Checked = { query(text: string): Promise<unknown> }

type State = "ok" | "unavailable"

/** How long `/health` waits for an MCP database: well inside Kubernetes' one-second probe, since a busy MCP pool is load, not a fault of this pod. */
const mcpWaitMs = 250

const check = (database: Checked): Promise<State> => database.query("select 1").then(() => "ok", () => "unavailable")
function within(database: Checked): Promise<State> {
  let timer: Timer | undefined
  const late = new Promise<State>(resolve => { timer = setTimeout(resolve, mcpWaitMs, "unavailable") })
  return Promise.race([check(database), late]).finally(() => clearTimeout(timer))
}
const states = async (databases: Readonly<Record<string, Checked>>, checked: (database: Checked) => Promise<State>) =>
  Object.fromEntries(await Promise.all(Object.entries(databases).map(async ([name, database]) => [name, await checked(database)] as const)))

/**
 * `GET /health`, the readiness check: `200` with `{ status: "ok", databases, providers }` while each of `own`, the server's own databases, answers
 * `select 1`, else `503` with `status: "unavailable"`. `databases` says `ok` or `unavailable` for each by name, the MCP databases of `mcps`
 * included: one that fails, or does not answer within 250 ms, is `unavailable` there and never fails the check. `providers` lists the ids of the
 * MCPs the server serves.
 */
export function health(own: Readonly<Record<string, Checked>>, providers: readonly string[], mcps: Readonly<Record<string, Checked>> = {}) {
  return async () => {
    const [ours, theirs] = await Promise.all([states(own, check), states(mcps, within)])
    const ok = Object.values(ours).every(state => state === "ok")
    return Response.json({ status: ok ? "ok" : "unavailable", databases: { ...ours, ...theirs }, providers }, { status: ok ? 200 : 503 })
  }
}
