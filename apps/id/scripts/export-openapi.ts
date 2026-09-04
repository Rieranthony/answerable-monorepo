import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { createDatabase } from "../src/db/client.ts";
import { loadEnvironment } from "../src/env.ts";
import { buildPublicOpenApiDocument } from "../src/http/openapi.ts";

const environment = loadEnvironment();
const database = createDatabase(environment);

try {
  const auth = createAuth(database.db, environment);
  const app = createApp({ auth, db: database.db, environment });
  const document = await buildPublicOpenApiDocument({
    app,
    auth,
    environment,
    servers: [
      { url: Bun.env.PUBLIC_ID_URL ?? "https://id.answerable.org" },
    ],
  });

  await Bun.write(
    new URL("../openapi.json", import.meta.url),
    `${JSON.stringify(document, null, 2)}\n`,
  );
} finally {
  await database.close();
}
