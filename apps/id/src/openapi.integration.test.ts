import { afterAll, beforeAll, expect, test } from "bun:test";

import { testEnvironment } from "./__tests__/support.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { createDatabase, type DatabaseConnection } from "./db/client.ts";
import { isAllowedAuthRoute } from "./http/auth-allowlist.ts";
import type { PublicOpenApiDocument } from "./http/openapi.ts";

let connection: DatabaseConnection;

beforeAll(() => {
  connection = createDatabase(testEnvironment());
});

afterAll(async () => {
  await connection.close();
});

function withoutServers(
  document: PublicOpenApiDocument,
): Partial<PublicOpenApiDocument> {
  const copy: Partial<PublicOpenApiDocument> = structuredClone(document);
  delete copy.servers;
  return copy;
}

test("the public OpenAPI snapshot matches the served document", async () => {
  const environment = testEnvironment();
  const auth = createAuth(connection.db, environment);
  const app = createApp({ auth, db: connection.db, environment });
  const response = await app.request("/openapi.json");
  const document = (await response.json()) as PublicOpenApiDocument;
  const snapshot = (await Bun.file(
    new URL("../openapi.json", import.meta.url),
  ).json()) as PublicOpenApiDocument;

  expect(response.status).toBe(200);
  expect(
    withoutServers(document),
    "Public OpenAPI snapshot drifted; run `bun run openapi:export` from apps/id.",
  ).toEqual(withoutServers(snapshot));

  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (path === "/healthz" || path === "/readyz") continue;

    for (const method of Object.keys(pathItem)) {
      expect(isAllowedAuthRoute(method, path)).toBe(true);
    }
  }
});
