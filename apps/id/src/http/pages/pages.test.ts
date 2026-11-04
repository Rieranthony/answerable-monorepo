import type { PlatformApplications } from "../../auth/platform-applications.ts";
import type { Database } from "../../db/client.ts";
import { expect, test } from "bun:test";
import { createApp } from "../../app.ts";
import {
  stubAuth,
  stubDatabase,
  testEnvironment,
} from "../../__tests__/support.ts";
import { isPagePath } from "./index.ts";
import type { OAuthFlow } from "./views/oauth-request.tsx";

const memberId = "01900000-0000-7000-8000-000000000001";
const query = "client_id=client&sig=signed";
const flow: OAuthFlow = {
  client: {
    clientId: "client",
    name: "Test app",
    uri: "https://client.example",
  },
  resource: { name: "Test service", identifier: "https://service.example" },
  scopes: ["openid", "profile", "email", "offline_access", "custom:scope"],
  grantedScopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "custom:scope",
  ],
  memberships: [
    {
      memberId,
      organizationId: memberId,
      name: "Tenant",
      slug: "tenant",
      authenticated: true,
    },
  ],
  selectedMemberId: memberId,
  status: "selection",
  authenticationMethod: "directory",
};
type Reply = {
  data?: unknown;
  status?: number;
  cookies?: string[];
  throws?: boolean;
};
function fixture(
  replies: Record<string, Reply> = {},
  platformApplications: PlatformApplications = {},
  db: Database = stubDatabase(),
) {
  const requests: {
    path: string;
    method: string;
    headers: Headers;
    body: unknown;
  }[] = [];
  const auth = stubAuth();
  auth.handler = async (request) => {
    const path = new URL(request.url).pathname;
    requests.push({
      path,
      method: request.method,
      headers: request.headers,
      body: request.method === "POST" ? await request.json() : undefined,
    });
    const reply = replies[path] ?? {
      data:
        path === "/auth/get-session"
          ? null
          : path === "/auth/oauth2/flow"
            ? flow
            : { url: "https://issuer.example/next" },
    };
    if (reply.throws) throw new Error("Unavailable");
    return Response.json(reply.data ?? null, {
      status: reply.status ?? 200,
      headers: reply.cookies?.map((value) => ["set-cookie", value]),
    });
  };
  return {
    app: createApp({
      auth,
      db,
      environment: testEnvironment({ platformApplications }),
    }),
    requests,
  };
}
// A database that records whether anything reached for it.
function watchedDatabase() {
  const watch = { touched: false };
  const db = new Proxy(
    {},
    {
      get() {
        watch.touched = true;
        throw new Error("Database unavailable");
      },
    },
  ) as Database;
  return { db, watch };
}
function post(
  body: Record<string, string> = {},
  origin = "http://localhost:47300",
) {
  return {
    method: "POST",
    headers: {
      origin,
      cookie: "session=old",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  };
}
async function html(response: Response, ...content: string[]) {
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("<script");
  for (const value of content) expect(text).toContain(value);
  return text;
}
test("login renders signed-out, signed-in, hinted and forced-authentication states", async () => {
  await html(
    await fixture().app.request("/login"),
    "Work email",
    "Continue",
    '<html lang="en" class="dark">',
  );
  await html(
    await fixture().app.request("/login?login_hint=person%40example.com"),
    'value="person@example.com"',
  );
  for (const reply of [{ status: 500 }, { throws: true }])
    await html(
      await fixture({ "/auth/get-session": reply }).app.request("/login"),
      "Work email",
    );
  const signedIn = {
    "/auth/get-session": { data: { user: { email: "person@example.com" } } },
  };
  await html(
    await fixture(signedIn).app.request("/login"),
    "Signed in as person@example.com",
    "Works with",
    "Verify sign-in or connect a work account",
    'action="/sign-out?"',
  );
  const redirect = await fixture(signedIn).app.request("/login?" + query);
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("location")).toBe("/authorize?" + query);
  for (const forced of ["prompt=select_account+login", "max_age=0"])
    await html(
      await fixture(signedIn).app.request("/login?" + query + "&" + forced),
      "Work email",
    );
});
test("automatic sign-in and sign-in errors retain the form and email", async () => {
  const f = fixture();
  const response = await f.app.request("/login?organization=tenant");
  expect(response.status).toBe(302);
  expect(f.requests[1]!.body).toMatchObject({ organizationSlug: "tenant" });
  expect(f.requests[1]!.headers.get("origin")).toBe("http://localhost:47300");
  for (const reply of [
    { data: { code: "platform_application_missing" }, status: 400 },
    { data: {} },
    { throws: true },
    {},
  ]) {
    await html(
      await fixture({ "/auth/sign-in/sso": reply }).app.request(
        "/login?organization=tenant",
      ),
      'role="alert"',
      "Work email",
    );
  }
  await html(await fixture().app.request("/login", post()), 'role="alert"');
});
test("sign-out clears cookies and handles service failures", async () => {
  const f = fixture({
    "/auth/sign-out": { data: {}, cookies: ["session=; Max-Age=0"] },
  });
  const response = await f.app.request("/sign-out?organization=tenant", post());
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/login?organization=tenant");
  expect(response.headers.getSetCookie()).toEqual(["session=; Max-Age=0"]);
  expect(f.requests[0]!.body).toEqual({});
  for (const reply of [{ status: 400 }, { throws: true }])
    await html(
      await fixture({
        "/auth/sign-out": reply,
        "/auth/get-session": {
          data: { user: { email: "person@example.com" } },
        },
      }).app.request("/sign-out", post()),
      "couldn&#39;t sign you out",
      "Please try again.",
      "Works with",
    );
  await html(
    await fixture({ "/auth/sign-out": { status: 400 } }).app.request(
      "/sign-out?organization=tenant",
      post(),
    ),
    'role="alert"',
  );
});
test("OAuth views show request details, selection, consent and empty states", async () => {
  await html(
    await fixture().app.request("/authorize?" + query),
    "Choose an organisation",
    "Application address",
    "Test service",
    "https://service.example",
    "Tenant",
    'name="member"',
    "Continue",
  );
  await html(
    await fixture({
      "/auth/oauth2/flow": { data: { ...flow, status: "consent" } },
    }).app.request("/consent?" + query),
    "Access it will receive",
    "Confirm who you are",
    "Read your name",
    "Read your email address",
    "Stay connected after you leave",
    '<code class="font-mono text-xs">custom:scope</code>',
    'value="accept"',
    'value="deny"',
  );
  await html(
    await fixture({
      "/auth/oauth2/flow": {
        data: {
          ...flow,
          memberships: [{ ...flow.memberships[0], authenticated: false }],
        },
      },
    }).app.request("/authorize"),
    "Sign in",
  );
  await html(
    await fixture({
      "/auth/oauth2/flow": {
        data: {
          ...flow,
          client: { clientId: "client", name: null, uri: null },
          resource: null,
          memberships: [],
          selectedMemberId: null,
        },
      },
    }).app.request("/authorize"),
    "This application",
    "No organisation is available for this account.",
  );
  for (const path of ["/authorize", "/consent"]) {
    await html(
      await fixture({
        "/auth/oauth2/flow": {
          data: { ...flow, status: "consent", selectedMemberId: null },
        },
      }).app.request(path),
      "Return to the application",
    );
    for (const reply of [{ status: 400 }, { throws: true }, {}])
      await html(
        await fixture({ "/auth/oauth2/flow": reply }).app.request(path),
        "This request has expired or is unavailable.",
      );
  }
});
test("organisation selection validates membership and forwards the correct action", async () => {
  for (const member of ["invalid", "01900000-0000-7000-8000-000000000002"])
    await html(
      await fixture().app.request("/authorize?" + query, post({ member })),
      "Access is unavailable for this organisation.",
    );
  await html(
    await fixture({ "/auth/oauth2/flow": { status: 400 } }).app.request(
      "/authorize",
      post({ member: memberId }),
    ),
    "Access is unavailable",
  );
  for (const authenticated of [true, false]) {
    const replies = {
      "/auth/oauth2/flow": {
        data: {
          ...flow,
          memberships: [{ ...flow.memberships[0], authenticated }],
        },
      },
    };
    const f = fixture(replies);
    expect(
      (await f.app.request("/authorize?" + query, post({ member: memberId })))
        .status,
    ).toBe(302);
    expect(f.requests[1]!.body).toEqual(
      authenticated
        ? { oauth_query: query, postLogin: true, memberId }
        : {
            organizationSlug: "tenant",
            oauth_query: query,
            callbackURL: "http://localhost:47300/authorize?" + query,
            errorCallbackURL: `http://localhost:47300/error?${query}&firm=tenant`,
          },
    );
    for (const reply of [{ status: 400 }, { throws: true }, { data: {} }])
      await html(
        await fixture({
          ...replies,
          [authenticated ? "/auth/oauth2/continue" : "/auth/sign-in/sso"]:
            reply,
        }).app.request("/authorize", post({ member: memberId })),
        authenticated ? "Access is unavailable" : "start your organisation",
      );
  }
});
test("consent records accept and deny and renders recoverable failures", async () => {
  for (const decision of ["accept", "deny"]) {
    const f = fixture();
    expect(
      (await f.app.request("/consent?" + query, post({ decision }))).status,
    ).toBe(302);
    expect(f.requests[0]!.body).toEqual({
      oauth_query: query,
      accept: decision === "accept",
    });
    for (const reply of [{ status: 400 }, { throws: true }, { data: {} }])
      await html(
        await fixture({ "/auth/oauth2/consent": reply }).app.request(
          "/consent",
          post({ decision }),
        ),
        "Your choice could not be recorded.",
      );
  }
  await html(
    await fixture().app.request("/consent", post({ decision: "invalid" })),
    "Your choice could not be recorded.",
  );
});
test("error pages show code-shaped descriptions only and render known, unknown and absent codes", async () => {
  for (const suffix of ["", "?error=unknown", "?error=invalid_state"])
    await html(
      await fixture().app.request("/error" + suffix),
      "Try another email",
    );
  await html(
    await fixture().app.request(
      "/error?error=invalid_state&error_description=sso_provider_changed_during_authentication",
    ),
    "sso_provider_changed_during_authentication",
  );
  for (const description of [
    "%3Cscript%3E",
    "Your+account+is+locked.+Call+0800+000+000",
    "x".repeat(129),
  ]) {
    const text = await html(
      await fixture().app.request(`/error?error_description=${description}`),
      "Try another email",
    );
    expect(text).not.toContain("script&gt;");
    expect(text).not.toContain("account is locked");
    expect(text).not.toContain("x".repeat(129));
  }
});
test("security session states and verification actions", async () => {
  await html(
    await fixture().app.request("/security"),
    "to verify or connect a work account.",
  );
  await html(
    await fixture().app.request("/security?error=invalid_state"),
    "Start again from the sign-in page.",
  );
  for (const reply of [{ status: 500 }, { throws: true }])
    await html(
      await fixture({ "/auth/get-session": reply }).app.request("/security"),
      "check your sign-in",
    );
  const session = {
    "/auth/get-session": { data: { user: { email: "person@example.com" } } },
  };
  await html(
    await fixture(session).app.request("/security"),
    "Signed in as person@example.com",
    "Verify your sign-in",
    "Connect another work account",
    'maxlength="200"',
  );
  for (const purpose of ["verify", "link"]) {
    const path =
      purpose === "verify" ? "/auth/sso/reauthenticate" : "/auth/sso/link";
    const f = fixture({
      ...session,
      [path]: {
        data: { url: "https://issuer.example/verify" },
        cookies: ["state=abc"],
      },
    });
    const response = await f.app.request(
      "/security/" + purpose,
      post({ provider: " tenant " }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.getSetCookie()).toEqual(["state=abc"]);
    expect(f.requests[0]!.body).toEqual({
      callbackURL: "http://localhost:47300/security",
      errorCallbackURL: "http://localhost:47300/security",
      ...(purpose === "link" ? { providerId: "tenant" } : {}),
    });
    for (const reply of [
      { status: 400, data: { code: "invalid_state" } },
      { data: { code: 7 } },
      {},
      { throws: true },
    ])
      await html(
        await fixture({ ...session, [path]: reply }).app.request(
          "/security/" + purpose,
          post({ provider: "tenant" }),
        ),
        'role="alert"',
      );
  }
  await html(
    await fixture(session).app.request(
      "/security/link",
      post({ provider: " " }),
    ),
    'role="alert"',
  );
});
test("pages carry security headers and serve their assets; API routes do not", async () => {
  const f = fixture();
  const response = await f.app.request("/login");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  );
  expect(response.headers.get("content-security-policy")).not.toContain(
    "form-action",
  );
  expect(response.headers.get("referrer-policy")).toBe("same-origin");
  expect(response.headers.get("cross-origin-opener-policy")).toBeNull();
  expect(
    (await f.app.request("/auth/get-session")).headers.get(
      "content-security-policy",
    ),
  ).toBeNull();
  const css = await f.app.request("/assets/tailwind.css");
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toContain("text/css");
  // The prebuilt file, served as it is: the same bytes a deployment serves.
  expect(css.headers.get("cache-control")).toBe("public, max-age=3600");
  expect(await css.text()).toContain("--font-sans");
  const font = await f.app.request("/assets/fonts/public-sans.woff2");
  expect(font.status).toBe(200);
  expect(font.headers.get("content-type")).toBe("font/woff2");
  expect(font.headers.get("cache-control")).toContain("immutable");
  expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  for (const path of [
    "/login",
    "/authorize",
    "/consent",
    "/security",
    "/security/verify",
    "/security/link",
    "/error",
    "/sign-out",
    "/assets/tailwind.css",
    "/assets/fonts/public-sans.woff2",
  ])
    expect(isPagePath(path)).toBe(true);
  for (const path of [
    "/auth/get-session",
    "/api/admin/v1",
    "/unknown",
    "/login/child",
  ])
    expect(isPagePath(path)).toBe(false);
});

test("page mounting preserves issuer discovery at both public paths", async () => {
  const auth = stubAuth();
  Object.assign(auth.api, {
    getOpenIdConfig: async () => ({ issuer: "http://localhost:47300" }),
  });
  const app = createApp({
    auth,
    db: stubDatabase(),
    environment: testEnvironment(),
  });
  for (const path of [
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
  ]) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: "http://localhost:47300",
    });
    expect(response.headers.get("content-security-policy")).toBeNull();
  }
});

test("login footer shows supported directories regardless of platform credentials", async () => {
  const microsoft = {
    clientId: "private-microsoft-id",
    clientSecret: "private-microsoft-secret",
  };
  const google = {
    clientId: "private-google-id",
    clientSecret: "private-google-secret",
  };
  for (const applications of [{ microsoft, google }, { microsoft }, {}]) {
    const text = await html(
      await fixture({}, applications).app.request("/login"),
      "Works with",
      "Microsoft Entra ID",
      "Google Workspace",
    );
    expect(text).not.toContain("Not available");
    expect(text).not.toContain("grayscale");
    for (const value of [...Object.values(microsoft), ...Object.values(google)])
      expect(text).not.toContain(value);
    expect(text).not.toContain("style=");
  }
});
test("invalid email re-renders with the footer without calling auth", async () => {
  for (const email of [
    "",
    "missing-at",
    "person@",
    "@example.com",
    "person@bad domain",
    "person@@example.com",
  ]) {
    const f = fixture();
    await html(
      await f.app.request("/login", post({ email })),
      'role="alert"',
      "Works with",
    );
    expect(f.requests).toHaveLength(0);
  }
});
test("login routes on an address of at most 254 characters and puts no longer one back", async () => {
  const atBound = "a".repeat(254 - "@example.com".length) + "@example.com";
  expect(atBound).toHaveLength(254);
  const accepted = watchedDatabase();
  const f = fixture({}, {}, accepted.db);
  await html(
    await f.app.request("/login", post({ email: atBound })),
    'role="alert"',
  );
  // The address passed the check, so the lookup was attempted.
  expect(accepted.watch.touched).toBe(true);
  for (const email of [
    "a" + atBound,
    "a@" + ".".repeat(3000),
    "a@" + ".".repeat(3000) + "x y",
  ]) {
    const refused = watchedDatabase();
    const f = fixture({}, {}, refused.db);
    const text = await html(
      await f.app.request("/login", post({ email })),
      'role="alert"',
      "We couldn&#39;t sign you in",
      "Works with",
    );
    expect(text).not.toContain(email.slice(0, 20));
    expect(f.requests).toHaveLength(0);
    expect(refused.watch.touched).toBe(false);
  }
  // A short address that does not match is still shown for correction.
  await html(
    await fixture().app.request("/login", post({ email: "person@" })),
    'value="person@"',
  );
});
test("a login hint is carried into the form only within 254 characters", async () => {
  const atBound = "a".repeat(254 - "@example.com".length) + "@example.com";
  await html(
    await fixture().app.request("/login?login_hint=" + atBound),
    `value="${atBound}"`,
  );
  for (const hint of ["a" + atBound, "a@" + ".".repeat(5000)]) {
    await html(
      await fixture().app.request("/login?login_hint=" + hint),
      "Work email",
      'value=""',
    );
  }
});
test("the login form limits the address field to 254 characters", async () => {
  await html(
    await fixture().app.request("/login"),
    'name="email"',
    'maxlength="254"',
  );
});
test("login refuses a post from another origin before it reads anything", async () => {
  const refusals: Record<string, string>[] = [
    { origin: "https://foreign.example" },
    // The same host on another scheme or port is another origin.
    { origin: "https://localhost:47300" },
    { origin: "http://localhost:47301" },
    { origin: "null" },
    { origin: "" },
    { "sec-fetch-site": "cross-site" },
    { origin: "http://localhost:47300", "sec-fetch-site": "cross-site" },
  ];
  for (const headers of refusals) {
    const watched = watchedDatabase();
    const f = fixture({}, {}, watched.db);
    const response = await f.app.request("/login?organization=tenant", {
      method: "POST",
      headers: {
        cookie: "session=old",
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams({ email: "person@second.example.com" }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
    const text = await response.text();
    for (const value of [
      'role="alert"',
      "We couldn&#39;t sign you in",
      "Work email",
      "Works with",
      'action="/login?organization=tenant"',
    ])
      expect(text).toContain(value);
    expect(text).not.toContain("person@second.example.com");
    expect(f.requests).toHaveLength(0);
    expect(watched.watch.touched).toBe(false);
  }
  // The answer does not wait for a body: one that cannot be parsed is not read.
  const response = await fixture().app.request("/login", {
    method: "POST",
    headers: {
      origin: "https://foreign.example",
      "content-type": "multipart/form-data",
    },
    body: "not a multipart body",
  });
  expect(response.status).toBe(403);
});
test("other pages do not show the directory footer", async () => {
  for (const path of ["/error", "/security", "/authorize", "/consent"]) {
    const text = await html(await fixture().app.request(path));
    expect(text).not.toContain("Works with");
    expect(text).not.toContain("<footer");
  }
});

test("consent lists granted access and names withheld scopes only when needed", async () => {
  for (const grantedScopes of [flow.scopes, ["openid", "custom:scope"], null]) {
    const response = await fixture({
      "/auth/oauth2/flow": {
        data: { ...flow, status: "consent", grantedScopes },
      },
    }).app.request("/consent?" + query);
    const text = await response.text();
    if (grantedScopes === null) {
      // Without a granted set there is nothing to accept.
      expect(text).not.toContain("Access it will receive");
      expect(text).not.toContain('value="accept"');
      expect(text).toContain("Return to the application");
    } else if (grantedScopes === flow.scopes) {
      expect(text).toContain("Access it will receive");
      expect(text).not.toContain("Not approved");
    } else {
      expect(text).toContain("Access it will receive");
      expect(text).toContain(
        'Not approved for Tenant: <code class="font-mono text-xs">profile</code>, <code class="font-mono text-xs">email</code>, <code class="font-mono text-xs">offline_access</code>',
      );
      expect(text).not.toContain("Read your email address");
    }
  }
});
