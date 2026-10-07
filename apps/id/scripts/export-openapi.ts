import { testEnvironment } from "../src/__tests__/support.ts";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { createDatabase } from "../src/db/client.ts";
import { buildPublicOpenApiDocument } from "../src/http/openapi.ts";

// The documents depend on no configuration but their servers, so the export
// builds them as the snapshot tests do; no query reaches the database.
const environment = testEnvironment();
const database = createDatabase(environment);

try {
  const auth = createAuth(database.db, environment);
  const app = createApp({ auth, db: database.db, environment });
  const servers = [{ url: "https://id.answerable.org" }];
  const document = await buildPublicOpenApiDocument({
    app,
    auth,
    environment,
    servers,
  });

  await Bun.write(
    new URL("../openapi.json", import.meta.url),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  const response = await app.request("/api/admin/openapi.json");
  if (!response.ok)
    throw new Error(`Admin OpenAPI export failed: ${response.status}`);
  const adminDocument = { ...(await response.json()), servers };
  await Bun.write(
    new URL("../openapi.admin.json", import.meta.url),
    `${JSON.stringify(adminDocument, null, 2)}\n`,
  );
} finally {
  await database.close();
}
