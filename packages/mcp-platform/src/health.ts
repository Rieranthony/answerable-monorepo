/** A database `/health` checks: a `pg` pool, or anything that answers a query. */
export type Checked = { query(text: string): Promise<unknown> }

/**
 * `GET /health`: `200` with `{ status: "ok", databases, providers }` when every database of `databases` answers `select 1`, else `503` with
 * `status: "unavailable"`; `databases` says `ok` or `unavailable` for each by name, and `providers` lists the ids of the MCPs the server serves.
 */
export function health(databases: Readonly<Record<string, Checked>>, providers: readonly string[]) {
  return async () => {
    const answers = await Promise.all(Object.entries(databases).map(async ([name, database]) => [name, await database.query("select 1").then(() => "ok", () => "unavailable")] as const))
    const ok = answers.every(([, answer]) => answer === "ok")
    return Response.json({ status: ok ? "ok" : "unavailable", databases: Object.fromEntries(answers), providers }, { status: ok ? 200 : 503 })
  }
}
