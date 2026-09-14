import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { inPlatformWrite } from "../../__tests__/platform-context.ts";
import {
  entitlements,
  oauthClients,
  oauthResources,
  oauthClientResources,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { createCapability } from "../../services/capabilities.ts";
import { hashClientSecret } from "../../services/client-secrets.ts";

let fixture: AdminFixture;
const clientId = "pages-client";
const resource = "https://service.example/mcp";
const redirect = "https://client.example/callback";
const secret = "page-client-secret";
const verifier = "v".repeat(64);
beforeEach(async () => {
  fixture = undefined!;
  fixture = await createAdminFixture();
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    clientSecret: hashClientSecret(secret),
    name: "OmniChat",
    uri: "https://client.example",
    organizationId: fixture.tenant.organizationId,
    scopes: ["openid", "email", "offline_access", "mail:read"],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    redirectUris: [redirect],
    tokenEndpointAuthMethod: "client_secret_basic",
    requirePKCE: true,
    skipConsent: false,
  });
  await fixture.db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Microsoft 365",
    allowedScopes: ["openid", "email", "offline_access", "mail:read"],
    accessTokenTtl: 300,
  });
  await fixture.db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource });
  await inPlatformWrite(fixture.db, async (context) => {
    for (const input of [
      {
        clientId,
        resource: null,
        grantKind: "authorization_code" as const,
        scopes: ["openid", "email", "offline_access"],
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
      await createCapability(context, fixture.tenant.organizationId, input);
  });
  await fixture.db.insert(entitlements).values([
    {
      id: createId(),
      organizationId: fixture.tenant.organizationId,
      clientId,
      scopes: ["openid", "email", "offline_access"],
    },
    {
      id: createId(),
      organizationId: fixture.tenant.organizationId,
      clientId,
      resource,
      scopes: ["mail:read"],
    },
  ]);
});
afterEach(async () => {
  await fixture?.close();
});

function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}
function page(path: string, session = "", fields?: Record<string, string>) {
  return fixture.app.request(path, {
    method: fields ? "POST" : "GET",
    headers: {
      cookie: session,
      origin: fixture.environment.betterAuthUrl,
      ...(fields
        ? { "content-type": "application/x-www-form-urlencoded" }
        : {}),
    },
    ...(fields ? { body: new URLSearchParams(fields) } : {}),
  });
}
async function start(session = "") {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirect,
    scope: "openid offline_access mail:read",
    resource,
    state: "page-state",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  const response = await page("/auth/oauth2/authorize?" + query, session);
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}
async function finishSso(started: Response) {
  expect(started.status).toBe(302);
  expect(cookie(started)).not.toBe("");
  const upstream = await fetch(started.headers.get("location")!, {
    redirect: "manual",
  });
  expect(upstream.status).toBe(302);
  const callback = new URL(upstream.headers.get("location")!);
  // The identity provider returns the browser with a top-level navigation.
  const response = await fixture.app.request(
    callback.pathname + callback.search,
    {
      headers: {
        cookie: cookie(started),
        accept: "text/html",
        "sec-fetch-mode": "navigate",
      },
    },
  );
  expect(response.status).toBe(302);
  return response;
}
function enqueue() {
  fixture.issuer.enqueue({
    sub: "tenantAdmin-subject",
    email: "tenantadmin@tenant.example.com",
    email_verified: true,
    auth_time: Math.floor(Date.now() / 1000),
  });
}
test("organisation login forwards state and session cookies through the issuer", async () => {
  enqueue();
  const completed = await finishSso(await page("/login?organization=tenant"));
  expect(completed.headers.get("location")).toBe(
    fixture.environment.betterAuthUrl + "/login?organization=tenant",
  );
  expect(cookie(completed)).not.toBe("");
  const signedIn = await page("/login", cookie(completed));
  expect(signedIn.status).toBe(200);
  expect(await signedIn.text()).toContain(
    "Signed in as tenantadmin@tenant.example.com",
  );
});
for (const decision of ["accept", "deny"])
  test("browser selection and consent: " + decision, async () => {
    // A fresh request obtains the login query; the existing session then resumes it.
    const login = await start();
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.has("sig")).toBe(true);
    const session = fixture.principals.tenantAdmin.cookie;
    const selected = await page(login.pathname + login.search, session);
    expect(selected.status).toBe(302);
    const selection = new URL(
      selected.headers.get("location")!,
      fixture.environment.betterAuthUrl,
    );
    expect(selection.pathname).toBe("/authorize");
    const details = await page(selection.pathname + selection.search, session);
    expect(details.status).toBe(200);
    expect(await details.text()).toContain(
      fixture.principals.tenantAdmin.memberId,
    );
    const continued = await page(
      selection.pathname + selection.search,
      session,
      { member: fixture.principals.tenantAdmin.memberId },
    );
    expect(continued.status).toBe(302);
    const consent = new URL(continued.headers.get("location")!);
    expect(consent.pathname).toBe("/consent");
    expect(
      await (await page(consent.pathname + consent.search, session)).text(),
    ).toContain("Requested access");
    const result = await page(consent.pathname + consent.search, session, {
      decision,
    });
    expect(result.status).toBe(302);
    const callback = new URL(result.headers.get("location")!);
    if (decision === "accept")
      expect(callback.searchParams.get("code")).toBeTruthy();
    else expect(callback.searchParams.get("error")).toBe("access_denied");
  });
test("email login carries the signed OAuth query through SSO to selection", async () => {
  const login = await start();
  enqueue();
  const completed = await finishSso(
    await page(login.pathname + login.search, "", {
      email: "tenantadmin@tenant.example.com",
    }),
  );
  const selection = new URL(completed.headers.get("location")!);
  expect(selection.pathname).toBe("/authorize");
  expect(selection.searchParams.has("sig")).toBe(true);
  const details = await page(
    selection.pathname + selection.search,
    cookie(completed),
  );
  expect(details.status).toBe(200);
  expect(await details.text()).toContain(
    fixture.principals.tenantAdmin.memberId,
  );
});
test("security renders both actions and forwards verification state cookies", async () => {
  const session = fixture.principals.tenantAdmin.cookie;
  const security = await page("/security", session);
  const content = await security.text();
  expect(content).toContain("Verify your sign-in");
  expect(content).toContain("Connect another work account");
  const verify = await page("/security/verify", session, {});
  expect(verify.status).toBe(302);
  expect(new URL(verify.headers.get("location")!).origin).toBe(
    fixture.issuer.origin,
  );
  expect(cookie(verify)).not.toBe("");
});
