import {
  approveAdminCapability,
  approveMachineCapability,
} from "./capabilities.ts";
import { platformWriteService } from "./platform-context.ts";
import { expect } from "bun:test";
import { and, eq, gte, sql } from "drizzle-orm";
import { generateKeyPair, SignJWT } from "jose";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { bootstrap, platformScopes, systemActor } from "../bootstrap.ts";
import { createDatabase } from "../db/client.ts";
import { upsertGroupMember } from "./group-queries.ts";
import {
  createClient as createClientImplementation,
  linkResource as linkResourceImplementation,
} from "../services/clients.ts";
const createClient = platformWriteService(createClientImplementation);
const linkResource = platformWriteService(linkResourceImplementation);
import { createOrganizationDomain } from "./domain-queries.ts";
import { createSsoProvider } from "./sso-queries.ts";
import {
  auditEvents,
  entitlements,
  members,
  organizations,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { signInThroughIdp } from "./federation.ts";
import { startOidcIssuer } from "./oidc-issuer.ts";
import { testEnvironment } from "./support.ts";

type Name =
  | "platformAdmin"
  | "platformReader"
  | "tenantAdmin"
  | "tenantReader"
  | "tenantUsersOnly"
  | "outsider"
  | "noGrant"
  | "expiredMember"
  | "disabledUser";
type FixturePrincipal = {
  cookie: string;
  userId: string;
  memberId: string;
  organizationId: string;
};

export type AdminFixture = Awaited<ReturnType<typeof createAdminFixture>>;

export async function createAdminFixture(
  overrides: Partial<import("../env.ts").Environment> = {},
) {
  const issuer = await startOidcIssuer();
  const trustedOrigin = "https://console.example.com";
  const environment = testEnvironment({
    trustedOrigins: [issuer.origin, trustedOrigin],
    rootAdminSecret: "fixture-root-secret-at-least-32-characters",
    rootAdminBreakGlass: true,
    operationReplay: {
      activeKeyId: "test",
      keys: { test: Buffer.alloc(32, 3).toString("base64url") },
    },
    ...overrides,
  });
  const connection = createDatabase(environment);
  const { db } = connection;
  async function close() {
    issuer.stop();
    await connection.close();
  }
  try {
    await db.execute(sql`
      truncate table audit_events, entitlements, group_members, groups,
      organization_domains, sso_providers, oauth_client_assertions,
      oauth_access_tokens, oauth_refresh_tokens, oauth_consents,
      oauth_client_resources, oauth_resources, oauth_clients, jwks,
      invitations, members, sessions, accounts, verifications, organizations, users cascade
    `);
    const app = createApp({
      auth: createAuth(db, environment),
      ssoTest: { allowPrivateHosts: true },
      db,
      environment,
    });
    const bootstrapped = await bootstrap(db, systemActor("fixture"), {
      platformOrganizationSlug: environment.platformOrganizationSlug,
      platformOrganizationName: "Answerable",
      adminResourceIdentifier: environment.adminResourceIdentifier,
    });
    const client = await createClient(db, systemActor("fixture"), {
      clientId: "answerable-bootstrap",
      name: "Admin fixture",
      organizationId: bootstrapped.organization.id,
      grantTypes: ["client_credentials"],
      tokenEndpointAuthMethod: "client_secret_basic",
      redirectUris: [],
      clientCredentialsScopes: [...platformScopes],
    });
    await linkResource(
      db,
      systemActor("fixture"),
      client.clientId,
      environment.adminResourceIdentifier,
    );
    await approveMachineCapability(db, {
      organizationId: bootstrapped.organization.id,
      clientId: client.clientId,
      resource: environment.adminResourceIdentifier,
      scopes: [...platformScopes],
    });
    expect(client.clientSecret).toBeString();
    const platform = {
      organizationId: bootstrapped.organization.id,
      slug: bootstrapped.organization.slug,
      groupId: bootstrapped.group.id,
      adminResource: environment.adminResourceIdentifier,
      client: {
        clientId: client.clientId,
        secret: client.clientSecret!,
      },
    };
    async function organization(slug: string, seededId?: string) {
      const organizationId = seededId ?? createId();
      const domain = `${slug}.example.com`;
      if (!seededId)
        await db
          .insert(organizations)
          .values({ id: organizationId, slug, name: slug });
      await createOrganizationDomain(db, { organizationId, domain });
      await createSsoProvider(db, {
        organizationId,
        providerId: slug,
        domain,
        issuer: issuer.origin,
        oidc: {
          clientId: `${slug}-client`,
          clientSecret: "secret",
          authorizationEndpoint: `${issuer.origin}/authorize`,
          tokenEndpoint: `${issuer.origin}/token`,
          jwksEndpoint: `${issuer.origin}/jwks`,
        },
      });
      return { organizationId, slug };
    }
    await organization(platform.slug, platform.organizationId);
    const tenant = await organization("tenant");
    const outsider = await organization("outsider");
    for (const org of [tenant, outsider])
      await approveAdminCapability(db, {
        organizationId: org.organizationId,
        resource: environment.adminResourceIdentifier,
        scopes: ["org:read", "org:users", "org:write"],
      });
    const principals = {} as Record<Name, FixturePrincipal>;
    const shapes: {
      name: Name;
      org: typeof tenant;
      domain: string;
      scopes: string[];
    }[] = [
      {
        name: "platformAdmin",
        org: platform,
        domain: "answerable.example.com",
        scopes: [],
      },
      {
        name: "platformReader",
        org: platform,
        domain: "answerable.example.com",
        scopes: ["platform:read"],
      },
      {
        name: "tenantAdmin",
        org: tenant,
        domain: "tenant.example.com",
        scopes: ["org:read", "org:users", "org:write"],
      },
      {
        name: "tenantReader",
        org: tenant,
        domain: "tenant.example.com",
        scopes: ["org:read"],
      },
      {
        name: "tenantUsersOnly",
        org: tenant,
        domain: "tenant.example.com",
        scopes: ["org:users"],
      },
      {
        name: "outsider",
        org: outsider,
        domain: "outsider.example.com",
        scopes: ["org:read", "org:users", "org:write"],
      },
      {
        name: "noGrant",
        org: tenant,
        domain: "tenant.example.com",
        scopes: [],
      },
      {
        name: "expiredMember",
        org: tenant,
        domain: "tenant.example.com",
        scopes: ["org:write"],
      },
      {
        name: "disabledUser",
        org: tenant,
        domain: "tenant.example.com",
        scopes: ["org:read"],
      },
    ];
    for (const { name, org, domain, scopes } of shapes) {
      const email = `${name.toLowerCase()}@${domain}`;
      issuer.enqueue({
        sub: `${name}-subject`,
        email,
        email_verified: true,
        name,
        auth_time: Math.floor(Date.now() / 1000),
      });
      const callbackURL = `${trustedOrigin}/callback`;
      const signedIn = await signInThroughIdp(app, {
        providerId: org.slug,
        callbackURL,
      });
      expect(signedIn.location, name).toBe(callbackURL);
      expect(signedIn.cookies.length, name).toBeGreaterThan(0);
      const [member] = await db
        .select({ memberId: members.id, userId: users.id })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .where(
          and(
            eq(members.organizationId, org.organizationId),
            eq(users.email, email),
          ),
        );
      expect(member, name).toBeDefined();
      principals[name] = {
        ...member!,
        organizationId: org.organizationId,
        cookie: signedIn.cookies
          .map((value) => value.split(";", 1)[0])
          .join("; "),
      };
      if (name === "platformAdmin") {
        await upsertGroupMember(db, {
          organizationId: platform.organizationId,
          groupId: platform.groupId,
          memberId: member!.memberId,
        });
      }
      if (scopes.length) {
        await db.insert(entitlements).values({
          id: createId(),
          organizationId: org.organizationId,
          memberId: member!.memberId,
          resource: platform.adminResource,
          scopes,
        });
      }
      if (name === "expiredMember") {
        await db.execute(
          sql`update members set valid_until = now() - interval '1 day' where id = ${member!.memberId}`,
        );
      }
      if (name === "disabledUser") {
        await db.execute(
          sql`update users set status = 'disabled', disabled_at = now() where id = ${member!.userId}`,
        );
      }
    }
    // Keep existing human/client fixture helpers typed to their supported principals.
    function headers(
      kind: Name | "root" | { bearer: string },
      extra?: { origin?: boolean | string },
    ): Headers;
    function headers(
      kind: Name | { bearer: string },
      extra?: { origin?: boolean | string },
    ): Headers;
    function headers(
      kind: Name | "root" | { bearer: string },
      extra: { origin?: boolean | string } = {},
    ) {
      const headers = new Headers();
      headers.set("Idempotency-Key", createId());
      if (kind === "root")
        headers.set("Authorization", `Bearer ${environment.rootAdminSecret}`);
      else if (typeof kind === "string")
        headers.set("Cookie", principals[kind].cookie);
      else headers.set("Authorization", `Bearer ${kind.bearer}`);
      if (extra.origin !== false)
        headers.set(
          "Origin",
          typeof extra.origin === "string" ? extra.origin : trustedOrigin,
        );
      return headers;
    }
    return {
      app,
      db,
      environment,
      issuer,
      trustedOrigin,
      platform,
      tenant,
      outsider,
      principals,
      async mintMachineToken(
        scopes: string[] = [...platformScopes],
      ): Promise<string> {
        const response = await app.request("/auth/oauth2/token", {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${platform.client.clientId}:${platform.client.secret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            resource: platform.adminResource,
            scope: scopes.join(" "),
          }),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { access_token: string };
        expect(body.access_token).toBeString();
        return body.access_token;
      },
      async foreignBearer(): Promise<string> {
        const { privateKey } = await generateKeyPair("RS256");
        return new SignJWT({
          scope: platformScopes.join(" "),
          azp: platform.client.clientId,
        })
          .setProtectedHeader({
            alg: "RS256",
            typ: "at+jwt",
            kid: crypto.randomUUID(),
          })
          .setIssuer(environment.betterAuthUrl)
          .setAudience(platform.adminResource)
          .setSubject(platform.client.clientId)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
      },
      headers,
      deniedEvents(since?: Date) {
        return db
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.action, "admin.denied"),
              since ? gte(auditEvents.occurredAt, since) : undefined,
            ),
          );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
