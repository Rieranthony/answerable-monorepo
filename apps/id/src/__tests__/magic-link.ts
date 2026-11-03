import { makeSignature } from "better-auth/crypto";
import { expect } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { Database } from "../db/client.ts";
import {
  accounts,
  entitlements,
  members,
  oauthClientResources,
  oauthClients,
  oauthResources,
  sessions,
  ssoProviders,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { createCapability } from "../services/capabilities.ts";
import { hashClientSecret } from "../services/client-secrets.ts";
import type { AdminFixture } from "./admin.ts";
import { createOrganizationDomain } from "./domain-queries.ts";
import { signInThroughIdp } from "./federation.ts";
import { createOrganization } from "./organization-queries.ts";
import { inPlatformWrite } from "./platform-context.ts";
import { createSsoProvider } from "./sso-queries.ts";

const callbackURL = "https://console.example.com/callback";
const clientId = "magic-link-client";
const clientSecret = "magic-link-client-secret";
const resource = "https://service.example/magic-link";
const redirect = "https://client.example/callback";
const verifier = "v".repeat(64);
const scopes = ["openid", "offline_access", "mail:read"];

/** The organisation's live magic-link row, which the database made with it. */
export async function liveMagicLinkRow(db: Database, organizationId: string) {
  const [row] = await db
    .select()
    .from(ssoProviders)
    .where(
      and(
        eq(ssoProviders.organizationId, organizationId),
        eq(ssoProviders.kind, "magic_link"),
        isNull(ssoProviders.deletedAt),
      ),
    );
  return row;
}

const cookieOf = (cookies: string[]) =>
  cookies.map((value) => value.split(";", 1)[0]).join("; ");

/** What the magic-link tests share: firms, real directory sign-ins, the sign-in result of
 * a release not built yet seeded directly, and real tokens from either session. */
export function magicLinkFirms(fixture: AdminFixture) {
  function directoryInput(slug: string) {
    const { origin } = fixture.issuer;
    return {
      issuer: origin,
      domain: `${slug}.example.com`,
      oidc: {
        clientId: `${slug}-client`,
        clientSecret: "secret",
        authorizationEndpoint: `${origin}/authorize`,
        tokenEndpoint: `${origin}/token`,
        jwksEndpoint: `${origin}/jwks`,
      },
    };
  }

  /** A firm with a domain, its magic-link row and, unless asked not to, a directory. */
  async function seedOrganization(slug: string, directory = true) {
    const organization = await createOrganization(fixture.db, {
      slug,
      name: slug,
    });
    const domain = `${slug}.example.com`;
    await createOrganizationDomain(fixture.db, {
      organizationId: organization.id,
      domain,
    });
    const row = directory
      ? await createSsoProvider(fixture.db, {
          ...directoryInput(slug),
          organizationId: organization.id,
          providerId: slug,
        })
      : null;
    const magicLink = await liveMagicLinkRow(fixture.db, organization.id);
    return { id: organization.id, slug, domain, magicLink: magicLink!, row };
  }
  type Organization = Awaited<ReturnType<typeof seedOrganization>>;

  /** Signs in through the organisation's directory, for real. */
  async function directorySignIn(
    organization: Organization,
    selector: Record<string, string> = { providerId: organization.slug },
    name = "person",
  ) {
    const email = `${name}@${organization.domain}`;
    fixture.issuer.enqueue({
      sub: `${organization.slug}-${name}`,
      email,
      email_verified: true,
      name,
      auth_time: Math.floor(Date.now() / 1000),
    });
    const signedIn = await signInThroughIdp(fixture.app, {
      ...selector,
      callbackURL,
    });
    expect(signedIn.location).toBe(callbackURL);
    const [member] = await fixture.db
      .select({ id: members.id, userId: members.userId })
      .from(members)
      .innerJoin(accounts, eq(accounts.userId, members.userId))
      .where(
        and(
          eq(members.organizationId, organization.id),
          eq(accounts.accountId, `${organization.slug}-${name}`),
        ),
      );
    return {
      email,
      memberId: member!.id,
      userId: member!.userId,
      cookie: cookieOf(signedIn.cookies),
    };
  }
  type Person = Awaited<ReturnType<typeof directorySignIn>>;

  /** The sign-in result seeded directly: the person's account with the magic-link row,
   * and a session whose origin names that row at its current revision. */
  async function magicLinkSession(
    organization: Organization,
    person: Pick<Person, "email" | "userId">,
    upstreamAuthTime: Date | null = null,
  ) {
    const [{ issuer, providerId, id, revision }] = (await fixture.db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.id, organization.magicLink.id))) as [
      typeof ssoProviders.$inferSelect,
    ];
    let [account] = await fixture.db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.userId, person.userId), eq(accounts.issuer, issuer)),
      );
    if (!account)
      [account] = await fixture.db
        .insert(accounts)
        .values({
          id: createId(),
          userId: person.userId,
          issuer,
          providerId,
          accountId: person.email,
        })
        .returning();
    const token = createId();
    const [session] = await fixture.db
      .insert(sessions)
      .values({
        id: createId(),
        userId: person.userId,
        token,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        authenticationOrganizationId: organization.id,
        authenticationProviderId: id,
        authenticationProviderRevision: revision,
        authenticationAccountId: account!.id,
        upstreamAuthTime,
      })
      .returning();
    const signature = await makeSignature(
      token,
      fixture.environment.betterAuthSecret,
    );
    return {
      session: session!,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    };
  }

  function protocol(
    path: string,
    init: { cookie?: string; json?: object; form?: Record<string, string> },
  ) {
    return fixture.app.fetch(
      new Request(`${fixture.environment.betterAuthUrl}/auth${path}`, {
        method: init.json || init.form ? "POST" : "GET",
        headers: {
          origin: fixture.trustedOrigin,
          ...(init.cookie ? { cookie: init.cookie } : {}),
          ...(init.json ? { "content-type": "application/json" } : {}),
          ...(init.form
            ? {
                "content-type": "application/x-www-form-urlencoded",
                authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
              }
            : {}),
        },
        ...(init.json ? { body: JSON.stringify(init.json) } : {}),
        ...(init.form ? { body: new URLSearchParams(init.form) } : {}),
      }),
    );
  }

  /** The client and resource the firms' people sign in to. Call once per fixture. */
  async function registerClient() {
    await fixture.db.insert(oauthClients).values({
      id: createId(),
      clientId,
      clientSecret: hashClientSecret(clientSecret),
      name: "Magic link client",
      uri: "https://client.example",
      scopes,
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [redirect],
      tokenEndpointAuthMethod: "client_secret_basic",
      skipConsent: false,
    });
    await fixture.db.insert(oauthResources).values({
      id: createId(),
      identifier: resource,
      name: "Service",
      allowedScopes: scopes,
      accessTokenTtl: 300,
    });
    await fixture.db
      .insert(oauthClientResources)
      .values({ id: createId(), clientId, resourceId: resource });
  }

  /** Everyone in the firm may use the client and the resource. */
  async function allowClient(organizationId: string) {
    await inPlatformWrite(fixture.db, async (context) => {
      for (const input of [
        {
          clientId,
          resource: null,
          grantKind: "authorization_code" as const,
          scopes: ["openid", "offline_access"],
        },
        {
          clientId,
          resource,
          grantKind: "authorization_code" as const,
          scopes: ["mail:read"],
        },
        {
          clientId,
          resource,
          grantKind: "refresh_token" as const,
          scopes: ["mail:read"],
        },
      ])
        await createCapability(context, organizationId, input);
    });
    await fixture.db.insert(entitlements).values([
      {
        id: createId(),
        organizationId,
        clientId,
        scopes: ["openid", "offline_access"],
      },
      {
        id: createId(),
        organizationId,
        clientId,
        resource,
        scopes: ["mail:read"],
      },
    ]);
  }

  /** The whole user flow from a browser session: authorise, select, consent, exchange. */
  async function issueTokens(cookie: string, memberId: string) {
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirect,
      scope: scopes.join(" "),
      resource,
      state: "client-state",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    const started = await protocol(`/oauth2/authorize?${query}`, { cookie });
    const selection = new URL(started.headers.get("location")!);
    expect(selection.pathname).toBe("/authorize");
    const selected = await protocol("/oauth2/continue", {
      cookie,
      json: {
        oauth_query: selection.search.slice(1),
        postLogin: true,
        memberId,
      },
    });
    expect(selected.status).toBe(200);
    const consent = new URL((await selected.json()).url);
    const accepted = await protocol("/oauth2/consent", {
      cookie,
      json: { oauth_query: consent.search.slice(1), accept: true },
    });
    expect(accepted.status).toBe(200);
    const code = new URL((await accepted.json()).url).searchParams.get("code")!;
    const exchanged = await protocol("/oauth2/token", {
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource,
      },
    });
    expect(exchanged.status).toBe(200);
    return (await exchanged.json()) as { refresh_token: string };
  }

  function refresh(token: string) {
    return protocol("/oauth2/token", {
      form: { grant_type: "refresh_token", refresh_token: token, resource },
    });
  }

  return {
    directoryInput,
    seedOrganization,
    directorySignIn,
    magicLinkSession,
    registerClient,
    allowClient,
    issueTokens,
    refresh,
  };
}
