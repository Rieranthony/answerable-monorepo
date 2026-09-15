export interface PlatformApplications {
  google: boolean
  microsoft: boolean
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/** Company account types in the order the sign-in page lists them. */
export const DIRECTORIES: ReadonlyArray<{
  application: keyof PlatformApplications
  name: string
}> = [
  { application: "microsoft", name: "Microsoft Entra ID" },
  { application: "google", name: "Google Workspace" },
]

/**
 * Asks Answerable ID which shared directory applications can sign people in.
 * Resolves to null whenever the answer is unknown, so callers show nothing.
 */
export async function readPlatformApplications(
  idURL: string | undefined,
  fetcher: Fetcher = fetch,
): Promise<PlatformApplications | null> {
  if (!idURL) return null
  try {
    const response = await fetcher(
      new URL("/platform-applications", idURL).toString(),
      { headers: { Accept: "application/json" } },
    )
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null) return null
    const { google, microsoft } = body as Record<string, unknown>
    return typeof google === "boolean" && typeof microsoft === "boolean"
      ? { google, microsoft }
      : null
  } catch {
    return null
  }
}
