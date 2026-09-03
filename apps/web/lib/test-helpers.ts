// Shared fakes for the Attio and waitlist unit tests. Not a test file itself.

export type RecordedCall = { url: string; init: RequestInit }

/** A fetch stand-in that records every call and serves queued responses. */
export function fakeFetch(responses: Array<() => Response>) {
  const calls: RecordedCall[] = []
  const fetch = async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init: init ?? {} })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected fetch call to ${input}`)
    return next()
  }
  return { fetch, calls }
}

export const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })

export const throwing = (error: unknown) => () => {
  throw error
}

export const personUpserted = json(200, {
  data: { id: { record_id: "rec_123" } },
})

export const entryUpserted = json(200, {
  data: { id: { entry_id: "ent_1" } },
})
