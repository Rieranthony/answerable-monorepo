import { oauthProviderClient } from "@better-auth/oauth-provider/client"
import { ssoClient } from "@better-auth/sso/client"
import { createAuthClient } from "better-auth/client"

const idURL = process.env.NEXT_PUBLIC_ID_URL

if (typeof window !== "undefined" && !idURL) {
  throw new Error(
    "NEXT_PUBLIC_ID_URL is required in the browser. Set it before building apps/web.",
  )
}

export const authClient = createAuthClient({
  baseURL: idURL,
  basePath: "/auth",
  plugins: [ssoClient(), oauthProviderClient()],
})
