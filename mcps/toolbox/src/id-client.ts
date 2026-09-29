import { z } from "zod"
import { IdError, type IdAdmin } from "./id"

const resourceView = z.object({ allowedScopes: z.array(z.string()).nullable(), clients: z.array(z.string()) })
const row = z.object({
  id: z.string(), clientId: z.string().nullable(), resource: z.string().nullable(), scopes: z.array(z.string()), status: z.string(),
  grantKind: z.string().optional(), memberId: z.string().nullish(), groupId: z.string().nullish(),
})
const page = z.object({ items: z.array(row), nextCursor: z.string().nullable() })

/** A capability or an entitlement of ID, as far as the enable operation reads it. */
export type Row = z.output<typeof row>

// ID's 404 for something the operation names is an answer, not a failure: the caller says which one was missing.
async function found<T>(read: () => Promise<T>) {
  try {
    return await read()
  } catch (error) {
    if (error instanceof IdError && error.status === 404) return undefined
    throw error
  }
}

/** The calls of ID's admin API that enabling the Toolbox for an organisation makes, for the Toolbox resource `resource`. */
export function createIdClient(admin: IdAdmin, resource: string) {
  const at = `/resources/${encodeURIComponent(resource)}`
  async function list(path: string) {
    const rows: Row[] = []
    let cursor: string | null = null
    do {
      const { body } = await admin.manage("GET", `${path}${path.includes("?") ? "&" : "?"}limit=200${cursor ? `&cursor=${cursor}` : ""}`)
      const next = page.parse(body)
      rows.push(...next.items)
      cursor = next.nextCursor
    } while (cursor)
    return rows
  }
  return {
    /** The Toolbox resource's allowed scopes, linked clients and current tag, or undefined when ID does not know it. */
    resource: () => found(async () => {
      const { body, etag } = await admin.manage("GET", at)
      const view = resourceView.parse(body)
      return { allowedScopes: view.allowedScopes ?? [], clients: view.clients, etag: etag! }
    }),
    /** Replace the resource's allowed scopes; `etag` makes a change made since it was read fail. */
    allowScopes: (allowedScopes: string[], etag: string) => admin.manage("PATCH", at, { body: { allowedScopes }, ifMatch: etag }),
    /** Link a client to the resource: false when ID does not know the client. */
    link: async (clientId: string) => (await found(() => admin.manage("PUT", `/clients/${encodeURIComponent(clientId)}${at}`))) !== undefined,
    /** Every capability of the organisation, or undefined when ID does not know it. */
    capabilities: (organisationId: string) => found(() => list(`/organizations/${organisationId}/capabilities`)),
    createCapability: (organisationId: string, body: { clientId: string; resource: string | null; grantKind: string; scopes: string[] }) =>
      admin.manage("POST", `/organizations/${organisationId}/capabilities`, { body }),
    /** Every entitlement of the organisation to a client, of any principal. */
    entitlements: (organisationId: string, clientId: string) => list(`/organizations/${organisationId}/entitlements?clientId=${encodeURIComponent(clientId)}`),
    createEntitlement: (organisationId: string, body: { clientId: string; resource?: string; scopes: string[] }) =>
      admin.manage("POST", `/organizations/${organisationId}/entitlements`, { body }),
  }
}
