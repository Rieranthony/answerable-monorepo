import { OAuthTestClient } from "./client"
import { pendingCookie, sessionCookie } from "./runtime"

function cookie(request: Request, name: string) {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ""
  )
}
function setCookie(
  headers: Headers,
  name: string,
  value: string,
  age: number,
  secure: boolean,
) {
  headers.append(
    "Set-Cookie",
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`,
  )
}
export async function handleOAuthTest(
  request: Request,
  action: string,
  enabled: boolean,
  getClient: () => OAuthTestClient,
) {
  const headers = new Headers({ "Cache-Control": "no-store" })
  if (!enabled) return new Response(null, { status: 404, headers })
  if (!["login", "callback", "refresh", "revoke", "logout"].includes(action))
    return new Response(null, { status: 404, headers })
  if (request.method !== (action === "callback" ? "GET" : "POST"))
    return new Response(null, { status: 405, headers })
  let client: OAuthTestClient
  try {
    client = getClient()
  } catch {
    return new Response("Configure the local OAuth test client first.", {
      status: 503,
      headers,
    })
  }
  const origin = new URL(client.config.redirectUri).origin
  const secure = origin.startsWith("https:")
  if (
    new URL(request.url).origin !== origin ||
    (action !== "callback" && request.headers.get("origin") !== origin)
  )
    return new Response("Invalid request origin", { status: 403, headers })
  const redirect = (location: string) => {
    headers.set("Location", location)
    return new Response(null, { status: 303, headers })
  }
  const id = cookie(request, sessionCookie)
  try {
    if (action === "login") {
      const result = await client.start()
      setCookie(headers, pendingCookie, result.browserId, 600, secure)
      return redirect(result.url)
    }
    if (action === "callback") {
      const session = await client.callback(
        cookie(request, pendingCookie),
        new URL(request.url).searchParams,
      )
      client.logout(id)
      setCookie(headers, pendingCookie, "", 0, secure)
      setCookie(headers, sessionCookie, session, 3600, secure)
      return redirect(`${origin}/oauth-test?result=signed-in`)
    }
    if (action === "logout") {
      client.logout(id)
      setCookie(headers, sessionCookie, "", 0, secure)
    } else if (action === "refresh") await client.refresh(id)
    else await client.revoke(id)
    return redirect(`${origin}/oauth-test?result=${action}`)
  } catch {
    // Neither provider responses nor callback parameters reach the page or logs.
    return redirect(`${origin}/oauth-test?result=${action}-failed`)
  }
}
