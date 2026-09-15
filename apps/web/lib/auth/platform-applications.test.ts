import { describe, expect, test } from "bun:test"

import { readPlatformApplications } from "./platform-applications"

function answer(outcome: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = []
  async function fetcher(url: string, init: RequestInit) {
    calls.push({ url, init })
    if (outcome instanceof Error) throw outcome
    return outcome
  }
  return { fetcher, calls }
}

describe("unit: platform application availability", () => {
  test("reads availability from Answerable ID", async () => {
    const { fetcher, calls } = answer(
      Response.json({ google: false, microsoft: true }),
    )

    expect(
      await readPlatformApplications("http://localhost:47300", fetcher),
    ).toEqual({ google: false, microsoft: true })
    expect(calls).toEqual([
      {
        url: "http://localhost:47300/platform-applications",
        init: { headers: { Accept: "application/json" } },
      },
    ])
  })

  test("is unknown without an ID URL", async () => {
    const { fetcher, calls } = answer(Response.json({}))

    expect(await readPlatformApplications(undefined, fetcher)).toBeNull()
    expect(calls).toEqual([])
  })

  test("is unknown when the request fails or the body is unexpected", async () => {
    for (const outcome of [
      new Response("unavailable", { status: 503 }),
      new Response("not json"),
      Response.json(null),
      Response.json({ google: "no", microsoft: true }),
      new Error("offline"),
    ]) {
      expect(
        await readPlatformApplications(
          "http://localhost:47300",
          answer(outcome).fetcher,
        ),
      ).toBeNull()
    }
  })
})
