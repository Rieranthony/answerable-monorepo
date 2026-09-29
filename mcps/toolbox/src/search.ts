import type { SQL } from "bun"

/**
 * Rank capabilities by the words of `query`, best first: Postgres full text over `capabilities.search`, where a word in the identity weighs
 * most, then the title, then the description, then an argument name. Any word matches, in its own form or, in titles and descriptions, another
 * English form. Only the `allowed` capabilities at their served versions are ranked; returns the identities from `offset`, at most `limit`.
 */
export async function search(db: SQL, query: string, allowed: readonly { identity: string; version: string }[], { limit, offset }: { limit: number; offset: number }) {
  // Letters and digits only, so the words cannot carry tsquery syntax.
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" | ")
  if (!words || !allowed.length) return []
  const served = JSON.stringify(allowed.map(({ identity, version }) => ({ identity, version })))
  const rows = await db`select identity from capabilities, (select to_tsquery('simple', ${words}) || to_tsquery('english', ${words}) as words) as query
    where (identity, version) in (select identity, version from jsonb_to_recordset(${served}::text::jsonb) as allowed (identity text, version text))
      and search @@ words
    order by ts_rank(search, words) desc, identity limit ${limit} offset ${offset}`
  return rows.map((row: { identity: string }) => row.identity)
}
