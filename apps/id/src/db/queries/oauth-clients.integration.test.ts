import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { oauthClients, organizations } from "../schema/index.ts";
import { findClientPrincipal } from "./oauth-clients.ts";

let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table organizations, oauth_clients cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});

test("integration: finds the client ceiling and owning organisation", async () => {
  const organizationId = createId();
  await connection.db
    .insert(organizations)
    .values({ id: organizationId, slug: "tenant", name: "Tenant" });
  await connection.db.insert(oauthClients).values({
    id: createId(),
    clientId: "owned",
    redirectUris: [],
    organizationId,
    clientCredentialsScopes: ["org:read"],
  });
  expect(await findClientPrincipal(connection.db, "owned")).toEqual({
    clientId: "owned",
    disabled: false,
    clientCredentialsScopes: ["org:read"],
    organizationId,
    organization: { id: organizationId, slug: "tenant", status: "active" },
  });
});
test("integration: preserves an unowned client through the left join", async () => {
  await connection.db.insert(oauthClients).values({
    id: createId(),
    clientId: "unowned",
    redirectUris: [],
    disabled: true,
  });
  expect(await findClientPrincipal(connection.db, "unowned")).toEqual({
    clientId: "unowned",
    disabled: true,
    clientCredentialsScopes: null,
    organizationId: null,
    organization: null,
  });
});
test("integration: returns null for an unknown client, including inside a transaction", async () => {
  expect(
    await connection.db.transaction((tx) => findClientPrincipal(tx, "unknown")),
  ).toBeNull();
});
