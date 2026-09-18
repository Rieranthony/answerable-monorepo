import { OAuthTestClient, type Config } from "./client"

export const sessionCookie = "answerable_oauth_test_session"
export const pendingCookie = "answerable_oauth_test_pending"
export function testConfig(): Config | null {
  const {
    OAUTH_TEST_ISSUER: issuer,
    OAUTH_TEST_CLIENT_ID: clientId,
    OAUTH_TEST_CLIENT_SECRET: clientSecret,
    OAUTH_TEST_REDIRECT_URI: redirectUri,
  } = process.env
  return issuer && clientId && clientSecret && redirectUri
    ? { issuer, clientId, clientSecret, redirectUri }
    : null
}
const runtime = globalThis as typeof globalThis & {
  answerableOAuthTest?: { key: string; client: OAuthTestClient }
}
export function testClient() {
  if (process.env.NODE_ENV !== "development")
    throw new Error("OAuth test is disabled")
  const config = testConfig()
  if (!config)
    throw new Error("Configure the OAuth test client in apps/web/.env.local")
  const key = JSON.stringify(config)
  if (runtime.answerableOAuthTest?.key !== key)
    runtime.answerableOAuthTest = { key, client: new OAuthTestClient(config) }
  return runtime.answerableOAuthTest.client
}
