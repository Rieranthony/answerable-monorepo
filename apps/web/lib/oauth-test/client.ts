import { createHash, randomBytes } from "node:crypto"
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose"

export type Config = {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
}
type Transport = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>
type Discovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  revocation_endpoint: string
}
type Pending = {
  expires: number
  state: string
  nonce: string
  verifier: string
}
type Identity = { sub: string; name?: string; email?: string; issuer: string }
type Session = {
  expires: number
  identity: Identity
  access?: string
  refresh?: string
  tokenExpires: number
  scopes: string
  busy?: boolean
}
type Tokens = {
  access_token: string
  refresh_token?: string
  id_token?: string
  token_type: string
  expires_in: number
  scope?: string
}
const random = () => randomBytes(32).toString("base64url")
const scopes = "openid profile email offline_access"

/** Development-only OAuth consumer. No ID session or database access. */
export class OAuthTestClient {
  private pending = new Map<string, Pending>()
  private sessions = new Map<string, Session>()
  constructor(
    readonly config: Config,
    private transport: Transport = fetch,
    private now = Date.now,
  ) {
    for (const value of [config.issuer, config.redirectUri]) {
      const u = new URL(value)
      if (
        u.username ||
        u.password ||
        u.hash ||
        u.search ||
        (u.protocol !== "https:" &&
          !(u.protocol === "http:" && u.hostname === "localhost"))
      )
        throw new Error("Invalid OAuth test URL")
    }
  }
  private prune() {
    for (const map of [this.pending, this.sessions])
      for (const [id, value] of map)
        if (value.expires <= this.now()) map.delete(id)
  }
  private room(map: Map<string, unknown>) {
    this.prune()
    if (map.size >= 1000)
      throw new Error("Too many test sessions. Try again later.")
  }
  private async discovery(): Promise<Discovery> {
    const r = await this.transport(
      `${this.config.issuer}/.well-known/openid-configuration`,
      {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!r.ok) throw new Error("ID discovery is unavailable")
    const d = (await r.json()) as Discovery
    if (d.issuer !== this.config.issuer) throw new Error("Unexpected ID issuer")
    for (const endpoint of [
      d.authorization_endpoint,
      d.token_endpoint,
      d.jwks_uri,
      d.revocation_endpoint,
    ]) {
      const u = new URL(endpoint)
      if (
        u.origin !== new URL(this.config.issuer).origin ||
        u.username ||
        u.password ||
        u.hash
      )
        throw new Error("Unexpected ID endpoint")
    }
    return d
  }
  private async post(url: string, body: URLSearchParams) {
    const encode = (value: string) =>
      new URLSearchParams({ v: value }).toString().slice(2)
    return this.transport(url, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${encode(this.config.clientId)}:${encode(this.config.clientSecret)}`).toString("base64")}`,
      },
      body: body.toString(),
    })
  }
  private async tokens(d: Discovery, body: URLSearchParams): Promise<Tokens> {
    const r = await this.post(d.token_endpoint, body)
    if (!r.ok)
      throw new Error("ID refused the token request. Start sign-in again.")
    const t = (await r.json()) as Tokens
    if (
      typeof t.access_token !== "string" ||
      !t.access_token ||
      t.token_type?.toLowerCase() !== "bearer" ||
      !Number.isFinite(t.expires_in) ||
      t.expires_in <= 0 ||
      (t.refresh_token !== undefined && typeof t.refresh_token !== "string")
    )
      throw new Error("Invalid token response")
    return t
  }
  private async identity(
    d: Discovery,
    token: string,
    nonce?: string,
  ): Promise<Identity> {
    const r = await this.transport(d.jwks_uri, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) throw new Error("ID signing keys are unavailable")
    const { payload } = await jwtVerify(
      token,
      createLocalJWKSet(await r.json()),
      {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        algorithms: ["RS256", "ES256", "EdDSA"],
        requiredClaims: ["sub", "exp", "iat"],
        currentDate: new Date(this.now()),
      },
    )
    if (nonce !== undefined && payload.nonce !== nonce)
      throw new Error("ID nonce mismatch")
    if (
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== this.config.clientId) ||
      (payload.azp !== undefined && payload.azp !== this.config.clientId)
    )
      throw new Error("Unexpected authorised party")
    return this.publicIdentity(payload)
  }
  private publicIdentity(p: JWTPayload): Identity {
    return {
      sub: p.sub!,
      issuer: p.iss!,
      ...(typeof p.name === "string" ? { name: p.name } : {}),
      ...(typeof p.email === "string" ? { email: p.email } : {}),
    }
  }
  async start() {
    const d = await this.discovery()
    this.room(this.pending)
    const browserId = random()
    const p = {
      expires: this.now() + 10 * 60_000,
      state: random(),
      nonce: random(),
      verifier: random(),
    }
    this.pending.set(browserId, p)
    const url = new URL(d.authorization_endpoint)
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: scopes,
      state: p.state,
      nonce: p.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(p.verifier)
        .digest("base64url"),
    }).toString()
    return { browserId, url: url.toString() }
  }
  async callback(browserId: string, query: URLSearchParams) {
    this.prune()
    const p = this.pending.get(browserId)
    if (
      !p ||
      query.getAll("state").length !== 1 ||
      query.get("state") !== p.state
    )
      throw new Error(
        "Sign-in state is missing, expired or does not match. Start again.",
      )
    this.pending.delete(browserId)
    if (query.has("error"))
      throw new Error("Access was denied. You can start sign-in again.")
    if (query.getAll("code").length !== 1 || !query.get("code"))
      throw new Error("The authorisation code is missing")
    if (query.has("iss") && query.get("iss") !== this.config.issuer)
      throw new Error("Unexpected callback issuer")
    const d = await this.discovery()
    const t = await this.tokens(
      d,
      new URLSearchParams({
        grant_type: "authorization_code",
        code: query.get("code")!,
        redirect_uri: this.config.redirectUri,
        code_verifier: p.verifier,
      }),
    )
    if (!t.id_token) throw new Error("ID token missing")
    const identity = await this.identity(d, t.id_token, p.nonce)
    this.room(this.sessions)
    const id = random()
    this.sessions.set(id, {
      expires: this.now() + 60 * 60_000,
      identity,
      access: t.access_token,
      refresh: t.refresh_token,
      tokenExpires: this.now() + t.expires_in * 1000,
      scopes: t.scope ?? scopes,
    })
    return id
  }
  view(id: string) {
    this.prune()
    const s = this.sessions.get(id)
    return {
      identity: s?.identity ?? null,
      scopes: s?.scopes ?? "",
      tokenExpires: s?.tokenExpires ?? null,
      canRefresh: !!s?.refresh,
      canRevoke: !!(s?.access || s?.refresh),
    }
  }
  private session(id: string) {
    this.prune()
    const s = this.sessions.get(id)
    if (!s) throw new Error("Test session expired. Sign in again.")
    if (s.busy) throw new Error("Another token operation is running")
    return s
  }
  async refresh(id: string) {
    const s = this.session(id)
    if (!s.refresh) throw new Error("No refresh token. Sign in again.")
    s.busy = true
    try {
      const d = await this.discovery()
      const t = await this.tokens(
        d,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: s.refresh,
        }),
      )
      if (t.id_token) {
        const identity = await this.identity(d, t.id_token)
        if (identity.sub !== s.identity.sub)
          throw new Error("Refreshed identity changed")
        s.identity = identity
      }
      s.access = t.access_token
      s.refresh = t.refresh_token ?? s.refresh
      s.tokenExpires = this.now() + t.expires_in * 1000
      s.scopes = t.scope ?? s.scopes
    } catch {
      // A timed-out rotation may have consumed the old token. Never retry it.
      s.access = undefined
      s.refresh = undefined
      throw new Error(
        "Refresh failed. Sign in again; the previous refresh token will not be reused.",
      )
    } finally {
      s.busy = false
    }
  }
  async revoke(id: string) {
    const s = this.session(id)
    s.busy = true
    try {
      const d = await this.discovery()
      for (const [token, hint] of [
        [s.refresh, "refresh_token"],
        [s.access, "access_token"],
      ]) {
        if (!token) continue
        const r = await this.post(
          d.revocation_endpoint,
          new URLSearchParams({ token, token_type_hint: hint! }),
        )
        if (!r.ok) throw new Error("Revocation failed. Retry or sign in again.")
      }
      s.access = undefined
      s.refresh = undefined
    } finally {
      s.busy = false
    }
  }
  logout(id: string) {
    this.sessions.delete(id)
  }
}
