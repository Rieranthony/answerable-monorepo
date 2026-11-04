import { describe, expect, spyOn, test } from "bun:test";
import { describeRoute } from "hono-openapi";

import {
  isUuidV7,
  stubAuth,
  stubDatabase,
  testEnvironment,
} from "./__tests__/support.ts";
import { createApp } from "./__tests__/app.ts";
import { isAllowedAuthRoute } from "./http/auth-allowlist.ts";
import { buildPublicOpenApiDocument } from "./http/openapi.ts";
import { ProblemError } from "./http/problem.ts";

describe("unit: Hono application", () => {
  test("health is independent from PostgreSQL and creates a UUIDv7 request id", async () => {
    let queries = 0;
    const app = createApp({
      auth: stubAuth(),
      db: Object.assign(stubDatabase(), {
        execute: async () => {
          queries += 1;
        },
      }),
      environment: testEnvironment(),
    });

    const response = await app.request("/healthz");
    const requestId = response.headers.get("x-request-id")!;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(queries).toBe(0);
    expect(isUuidV7(requestId)).toBe(true);
  });

  test("uses the problem handler for thrown route errors", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    app.get("/boom", () => {
      throw new ProblemError(418, "teapot", "Teapot");
    });
    const response = await app.request("/boom");
    expect(response.status).toBe(418);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Teapot",
      status: 418,
      code: "teapot",
      request_id: response.headers.get("x-request-id"),
    });
  });

  test("preserves a caller-provided request id", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    const response = await app.request("/healthz", {
      headers: { "x-request-id": "request-from-ingress" },
    });

    expect(response.headers.get("x-request-id")).toBe("request-from-ingress");
  });

  test("readiness reports an unavailable database", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: Object.assign(stubDatabase(), {
        execute: () => Promise.reject(new Error("offline")),
      }),
      environment: testEnvironment(),
    });

    const response = await app.request("/readyz");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  test("builds the public OpenAPI contract with an explicit server", async () => {
    const environment = testEnvironment();
    const auth = stubAuth();
    const app = createApp({ auth, db: stubDatabase(), environment });
    app.post(
      "/healthz",
      describeRoute({
        operationId: "postHealth",
        responses: { 200: { description: "OK" } },
      }),
      (context) => context.json({ status: "ok" }),
    );

    const document = await buildPublicOpenApiDocument({
      app,
      auth,
      environment,
      servers: [{ url: "https://id.example.com" }],
    });

    expect(document.tags).toContainEqual({
      name: "Token",
      description: "User authorisation and machine access",
    });
    expect(document.servers).toEqual([{ url: "https://id.example.com" }]);
    expect(Object.keys(document.paths["/healthz"]!)).toEqual(["get", "post"]);
  });

  test("can disable OpenAPI routes", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment({ openApiEnabled: false }),
    });

    expect((await app.request("/openapi.json")).status).toBe(404);
    expect((await app.request("/api/admin/openapi.json")).status).toBe(404);
  });

  test("serves the OpenAPI contract in production when enabled", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment({ nodeEnv: "production" }),
    });

    expect((await app.request("/openapi.json")).status).toBe(200);
    expect((await app.request("/api/admin/openapi.json")).status).toBe(200);
  });

  test("forwards only allowlisted Better Auth routes", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });

    expect(isAllowedAuthRoute("get", "/auth/ok")).toBe(false);
    expect(isAllowedAuthRoute("post", "/auth/sign-in/sso")).toBe(true);
    expect(isAllowedAuthRoute("get", "/auth/sso/callback")).toBe(true);
    expect(isAllowedAuthRoute("get", "/auth/get-session")).toBe(true);
    expect(isAllowedAuthRoute("post", "/auth/sign-out")).toBe(true);
    expect(isAllowedAuthRoute("POST", "/auth/organization/create")).toBe(false);
    expect((await app.request("/auth/get-session")).status).toBe(200);
    expect((await app.request("/auth/ok")).status).toBe(404);
    expect(
      (await app.request("/auth/organization/create", { method: "POST" }))
        .status,
    ).toBe(404);
  });

  test("answers trusted SSO preflights without reflecting untrusted origins", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment({
        trustedOrigins: ["https://chat.example.com"],
      }),
    });
    const preflight = (origin: string) =>
      app.request("/auth/sign-in/sso", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
        },
      });

    const trusted = await preflight("https://chat.example.com");
    const untrusted = await preflight("https://evil.example.com");
    expect(trusted.status).toBe(204);
    expect(trusted.headers.get("access-control-allow-origin")).toBe(
      "https://chat.example.com",
    );
    expect(trusted.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(untrusted.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("exposes identical public discovery to credential-free GET and HEAD callers", async () => {
    const auth = stubAuth();
    const metadata = {
      issuer: "http://localhost:47300",
      authorization_endpoint: "http://localhost:47300/auth/oauth2/authorize",
      token_endpoint: "http://localhost:47300/auth/oauth2/token",
      userinfo_endpoint: "http://localhost:47300/auth/oauth2/userinfo",
      jwks_uri: "http://localhost:47300/auth/jwks",
      id_token_signing_alg_values_supported: ["EdDSA"],
      code_challenge_methods_supported: ["S256"],
    };
    Object.assign(auth.api, { getOpenIdConfig: async () => metadata });
    const app = createApp({
      auth,
      db: stubDatabase(),
      environment: testEnvironment({
        trustedOrigins: ["https://chat.example.com"],
      }),
    });

    for (const path of [
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
    ]) {
      const baseline = await app.request(path);
      const document = await baseline.json();
      expect(document).toMatchObject(metadata);
      expect(baseline.headers.get("cache-control")).toContain("public");
      for (const origin of [
        undefined,
        "https://chat.example.com",
        "https://unregistered.example.com",
        "null",
      ]) {
        for (const method of ["GET", "HEAD"]) {
          const response = await app.request(path, {
            method,
            headers: origin ? { Origin: origin } : {},
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("access-control-allow-origin")).toBe("*");
          expect(
            response.headers.get("access-control-allow-credentials"),
          ).toBeNull();
          expect(response.headers.get("set-cookie")).toBeNull();
          expect(response.headers.get("content-type")).toBe(
            baseline.headers.get("content-type"),
          );
          expect(response.headers.get("cache-control")).toBe(
            baseline.headers.get("cache-control"),
          );
          expect(response.headers.get("vary")).toBeNull();
          if (method === "HEAD") expect(await response.text()).toBe("");
          else expect(await response.json()).toEqual(document);
        }
      }
    }
  });

  test("discovery preflights advertise only reads and vary on reflected request headers", async () => {
    let metadataCalls = 0;
    const auth = stubAuth();
    Object.assign(auth.api, {
      getOpenIdConfig: async () => {
        metadataCalls += 1;
        return {};
      },
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
      for (const method of ["GET", "HEAD", "POST"]) {
        for (const requestedHeaders of [
          undefined,
          "X-Request-Id, Cache-Control",
        ]) {
          const response = await app.request(path, {
            method: "OPTIONS",
            headers: {
              Origin: "https://unregistered.example.com",
              "Access-Control-Request-Method": method,
              ...(requestedHeaders
                ? { "Access-Control-Request-Headers": requestedHeaders }
                : {}),
            },
          });
          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-origin")).toBe("*");
          expect(
            response.headers.get("access-control-allow-credentials"),
          ).toBeNull();
          expect(response.headers.get("access-control-allow-methods")).toBe(
            "GET,HEAD",
          );
          expect(response.headers.get("access-control-allow-headers")).toBe(
            requestedHeaders ? "X-Request-Id,Cache-Control" : null,
          );
          expect(response.headers.get("vary")).toBe(
            requestedHeaders ? "Access-Control-Request-Headers" : null,
          );
          expect(await response.text()).toBe("");
        }
      }
    }
    expect(metadataCalls).toBe(0);
  });

  test("discovery writes and neighbouring paths gain no public CORS", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });

    for (const path of [
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
    ]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await app.request(path, {
          method,
          headers: { Origin: "https://unregistered.example.com" },
        });
        expect(response.status).toBe(404);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(
          response.headers.get("access-control-allow-credentials"),
        ).toBeNull();
      }
      for (const method of ["GET", "OPTIONS"]) {
        const response = await app.request(`${path}/private`, {
          method,
          headers: {
            Origin: "https://unregistered.example.com",
            "Access-Control-Request-Method": "GET",
          },
        });
        expect(response.status).toBe(404);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      }
    }
  });

  test("public discovery leaves auth CORS on its existing trusted-origin policy", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment({
        trustedOrigins: ["https://chat.example.com"],
      }),
    });

    for (const [path, method] of [
      ["/auth/oauth2/token", "POST"],
      ["/auth/oauth2/userinfo", "GET"],
      ["/auth/oauth2/userinfo", "POST"],
      ["/auth/jwks", "GET"],
      ["/auth/get-session", "GET"],
      ["/auth/oauth2/authorize", "GET"],
      ["/auth/oauth2/consent", "POST"],
    ] as const) {
      for (const origin of [
        "https://chat.example.com",
        "https://unregistered.example.com",
      ]) {
        for (const requestMethod of [method, "OPTIONS"]) {
          const response = await app.request(path, {
            method: requestMethod,
            headers: {
              Origin: origin,
              "Access-Control-Request-Method": method,
            },
          });
          expect(response.status).toBe(requestMethod === "OPTIONS" ? 204 : 200);
          expect(response.headers.get("access-control-allow-origin")).toBe(
            origin === "https://chat.example.com" ? origin : null,
          );
          expect(response.headers.get("access-control-allow-credentials")).toBe(
            "true",
          );
          expect(response.headers.get("vary")).toContain("Origin");
        }
      }
    }
  });

  test("private browser and admin routes gain no discovery CORS", async () => {
    const app = createApp({
      auth: { ...stubAuth(), handler: async () => Response.json(null) },
      db: stubDatabase(),
      environment: testEnvironment(),
    });

    for (const path of [
      "/api/admin/v1/unknown",
      "/api/admin/openapi.json",
      "/authorize",
      "/consent",
      "/login",
      "/security",
      "/openapi.json",
      "/healthz",
    ]) {
      for (const method of ["GET", "OPTIONS"]) {
        const response = await app.request(path, {
          method,
          headers: {
            Origin: "https://unregistered.example.com",
            "Access-Control-Request-Method": "GET",
          },
        });
        expect(response.status, `${method} ${path}`).toBeLessThan(500);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(
          response.headers.get("access-control-allow-credentials"),
        ).toBeNull();
      }
    }
  });

  test("blocks every unapproved SSO and OAuth provider endpoint", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    const blocked = [
      ["POST", "/auth/sso/register"],
      ["GET", "/auth/sso/providers"],
      ["GET", "/auth/sso/get-provider"],
      ["POST", "/auth/sso/update-provider"],
      ["POST", "/auth/sso/delete-provider"],
      ["POST", "/auth/sso/request-domain-verification"],
      ["POST", "/auth/sso/verify-domain"],
      ["GET", "/auth/sso/saml2/sp/metadata"],
      ["POST", "/auth/sso/saml2/sp/acs/x"],
      ["POST", "/auth/sso/saml2/sp/slo/x"],
      ["POST", "/auth/sso/saml2/logout/x"],
      ["GET", "/auth/sso/callback/x"],
      ["POST", "/auth/oauth2/authorize"],
      ["GET", "/auth/oauth2/consent"],
      ["POST", "/auth/oauth2/introspect"],
      ["POST", "/auth/oauth2/register"],
      ["GET", "/auth/oauth2/end-session"],
      ["GET", "/auth/oauth2/continue"],
    ] as const;

    for (const [method, path] of blocked) {
      expect((await app.request(path, { method })).status).toBe(404);
    }
  });

  test("returns structured JSON for unknown routes", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    const response = await app.request("/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

test("unknown admin routes return a problem without requiring credentials", async () => {
  const app = createApp({
    auth: stubAuth(),
    db: stubDatabase(),
    environment: testEnvironment(),
  });
  const response = await app.request("/api/admin/v1/unknown");
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(await response.json()).toMatchObject({ code: "not_found" });
});

test("mounted me runs principal resolution and the root problem handler", async () => {
  const auth = stubAuth();
  const calls: unknown[] = [];
  auth.api.getSession = (async (input: unknown) => {
    calls.push(input);
    return null;
  }) as typeof auth.api.getSession;
  const app = createApp({
    auth,
    db: stubDatabase(),
    environment: testEnvironment(),
  });
  const response = await app.request("/api/admin/v1/me");
  expect(response.status).toBe(401);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(response.headers.get("www-authenticate")).toBe(
    'Bearer realm="answerable-id-admin"',
  );
  expect(await response.json()).toMatchObject({ code: "unauthenticated" });
  expect(calls).toHaveLength(1);
});

test("auth catch-all propagates request ids and logs rejection redirects with them", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const requestId of [undefined, "ingress-id"]) {
      log.mockClear();
      let received: string | null = null;
      const auth = stubAuth();
      auth.handler = async (request: Request) => {
        received = request.headers.get("x-request-id");
        return Response.redirect(
          "https://example.com/error?error=directory_mismatch&error_description=x",
          302,
        );
      };
      const app = createApp({
        auth,
        db: stubDatabase(),
        environment: testEnvironment(),
      });
      const response = await app.request("/auth/sso/callback", {
        headers: requestId ? { "x-request-id": requestId } : {},
      });
      expect(response.status).toBe(302);
      expect(received as string | null).toBe(
        response.headers.get("x-request-id"),
      );
      expect(received).toBeTruthy();
      expect(log.mock.calls.map(([, json]) => JSON.parse(json))).toEqual([
        expect.objectContaining({
          event: "signin_rejected",
          reason: "directory_mismatch",
          requestId: received,
        }),
      ]);
    }
  } finally {
    log.mockRestore();
  }
});

test("unusable correlation headers are replaced consistently before auth", async () => {
  for (const supplied of [
    "x".repeat(129),
    "contains spaces",
    "",
    "comma,separated",
  ]) {
    let observed: string | null = null;
    const app = createApp({
      environment: testEnvironment(),
      db: stubDatabase(),
      auth: {
        ...stubAuth(),
        handler: async (request) => {
          observed = request.headers.get("x-request-id");
          return Response.json({ ok: true });
        },
      },
    });
    const response = await app.request("/auth/get-session", {
      headers: { "x-request-id": supplied },
    });
    expect(response.status).toBe(200);
    const actual = response.headers.get("x-request-id")!;
    expect(isUuidV7(actual)).toBe(true);
    expect(observed as string | null).toBe(actual);
    expect(actual).not.toBe(supplied);
  }
});

test("body guard counts actual bytes despite a false content length and cancels overflow", async () => {
  let called = false;
  let cancelled = false;
  const app = createApp({
    db: stubDatabase(),
    environment: testEnvironment(),
    auth: {
      ...stubAuth(),
      handler: async () => {
        called = true;
        return new Response();
      },
    },
  });
  const response = await app.request("/auth/sign-out", {
    method: "POST",
    headers: { "Content-Length": "1" },
    body: new ReadableStream({
      pull(output) {
        output.enqueue(new Uint8Array(16384));
      },
      cancel() {
        cancelled = true;
        throw new Error("untrusted cancellation error");
      },
    }),
  });
  expect(response.status).toBe(413);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(called).toBe(false);
  expect(cancelled).toBe(true);
});

test("unreadable bodies return a safe transport error before provider or admin work", async () => {
  for (const path of ["/auth/sign-out", "/api/admin/v1/organizations"]) {
    let called = false;
    const app = createApp({
      db: stubDatabase(),
      environment: testEnvironment(),
      auth: {
        ...stubAuth(),
        handler: async () => {
          called = true;
          return new Response();
        },
      },
    });
    const response = await app.request(path, {
      method: "POST",
      body: new ReadableStream({
        start(output) {
          output.error(new Error("private-body-error"));
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid Request Body");
    expect(called).toBe(false);
  }
});

test("maximum valid correlation ids survive in both context and auth headers", async () => {
  for (const value of ["a".repeat(128), "trace.00:part_1-final"]) {
    let received: string | null = null;
    const app = createApp({
      db: stubDatabase(),
      environment: testEnvironment(),
      auth: {
        ...stubAuth(),
        handler: async (request) => {
          received = request.headers.get("x-request-id");
          return new Response();
        },
      },
    });
    const response = await app.request("/auth/get-session", {
      headers: { "x-request-id": value },
    });
    expect(response.headers.get("x-request-id")).toBe(value);
    expect(received as string | null).toBe(value);
  }
});

test("preflight cannot bypass the incoming body limit", async () => {
  const app = createApp({
    db: stubDatabase(),
    auth: stubAuth(),
    environment: testEnvironment({
      trustedOrigins: ["https://client.example"],
    }),
  });
  const response = await app.request("/auth/sign-out", {
    method: "OPTIONS",
    headers: {
      Origin: "https://client.example",
      "Access-Control-Request-Method": "POST",
    },
    body: new Uint8Array(256 * 1024 + 1),
  });
  expect(response.status).toBe(413);
});

test("sign-in routes take smaller bodies than the rest, whole or streamed", async () => {
  const limits = [
    ["/login", 4 * 1024],
    ["/auth/sign-in/sso", 64 * 1024],
    ["/auth/sign-out", 256 * 1024],
  ] as const;
  const streamed = (size: number) => {
    let remaining = size;
    return new ReadableStream({
      pull(output) {
        const count = Math.min(1024, remaining);
        remaining -= count;
        if (count) output.enqueue(new Uint8Array(count));
        else output.close();
      },
    });
  };
  for (const [path, limit] of limits) {
    for (const [size, status] of [
      [limit, 200],
      [limit + 1, 413],
    ] as const) {
      for (const body of [new Uint8Array(size), streamed(size)]) {
        let reached = 0;
        const app = createApp({
          db: stubDatabase(),
          environment: testEnvironment(),
          auth: {
            ...stubAuth(),
            handler: async () => {
              reached += 1;
              return new Response();
            },
          },
        });
        const response = await app.request(path, {
          method: "POST",
          headers: { origin: "http://localhost:47300" },
          body,
        });
        expect(response.status).toBe(status);
        if (status === 413) {
          expect(await response.text()).toBe("Payload Too Large");
          expect(reached).toBe(0);
        }
        // The sign-in start reaches the service at the bound; the form
        // answers itself and the other route is the general case.
        if (path !== "/login" && status === 200) expect(reached).toBe(1);
      }
    }
  }
});

test("the 413 response of a sign-in route names the limit that route enforces", async () => {
  const document = await buildPublicOpenApiDocument({
    app: createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    }),
    auth: stubAuth(),
    environment: testEnvironment(),
  });
  const description = (path: string) =>
    (
      document.paths[path]!.post as {
        responses: Record<string, { description: string }>;
      }
    ).responses["413"]!.description;
  expect(description("/auth/sign-in/sso")).toContain("65536 bytes (64 KiB)");
  expect(description("/auth/sign-out")).toContain("262144 bytes (256 KiB)");
});

for (const path of [
  "/auth/sso%2Fregister",
  "/auth/../auth/sso/register",
  "//auth/sso/register",
  "/auth/oauth2/token/",
  "/AUTH/GET-SESSION",
  "/auth/get-session/../update-user",
]) {
  test(`auth allowlist rejects path bypass ${path}`, async () => {
    const auth = stubAuth();
    const reached: string[] = [];
    const app = createApp({
      auth: {
        ...auth,
        handler: async (request) => {
          reached.push(new URL(request.url).pathname);
          return Response.json({ ok: true });
        },
      },
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    const response = await app.fetch(
      new Request(`http://localhost:47300${path}`, { method: "POST" }),
    );
    expect(response.status).toBe(404);
    expect(reached).toEqual([]);
  });
}
for (const header of ["X-HTTP-Method-Override", "X-Method-Override"]) {
  test(`auth allowlist ignores ${header} on an allowed route`, async () => {
    const auth = stubAuth();
    const reached: string[] = [];
    const app = createApp({
      auth: {
        ...auth,
        handler: async (request) => {
          reached.push(`${request.method} ${new URL(request.url).pathname}`);
          return Response.json({ ok: true });
        },
      },
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    const response = await app.request("/auth/get-session", {
      headers: { [header]: "DELETE" },
    });
    expect(response.status).toBe(200);
    expect(reached).toEqual(["GET /auth/get-session"]);
  });
}
