import { AsyncLocalStorage } from "node:async_hooks"

const calls = new AsyncLocalStorage<string>()

/**
 * The organisation of the caller whose call is running now, or `undefined` outside a call. The server runs every `execute`, `prepare`, `commit`,
 * prompt and resource handler inside its call, so a database reached from one sees the caller's organisation. It is the getter `mcpDatabase`'s
 * `organisation` option takes, in `@answerable/mcp-postgres`.
 *
 * @example
 * ```ts
 * import { callerOrganisation } from "@answerable/mcp"
 * import { mcpDatabase } from "@answerable/mcp-postgres"
 *
 * const db = mcpDatabase(pool, { name: "acme", schema, organisation: callerOrganisation })
 * ```
 */
export const callerOrganisation = (): string | undefined => calls.getStore()

/** Run `work` as part of a call by a member of `organisationId`, so that `callerOrganisation()` gives it there. */
export const inCall = <T>(organisationId: string, work: () => T): T => calls.run(organisationId, work)
