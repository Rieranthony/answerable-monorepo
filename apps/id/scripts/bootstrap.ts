import { bootstrap, parseBootstrapEnvironment } from "../src/bootstrap.ts";
import { createDatabase } from "../src/db/client.ts";
import { loadEnvironment } from "../src/env.ts";

const environment = loadEnvironment();
const options = {
  ...parseBootstrapEnvironment(Bun.env),
  platformOrganizationSlug: environment.platformOrganizationSlug,
  adminResourceIdentifier: environment.adminResourceIdentifier,
};
const connection = createDatabase(environment);
try {
  const result = await bootstrap(connection.db, options);
  for (const [name, row] of Object.entries(result)) {
    const label =
      name === "organization"
        ? options.platformOrganizationSlug
        : name === "client"
          ? options.bootstrapClientId
          : "identifier" in row
            ? row.identifier
            : "id" in row
              ? row.id
              : options.bootstrapClientId;
    if (name === "client" && !row.created) {
      console.log(
        `client ${label}: already exists; rotate the secret through the admin API.`,
      );
    } else {
      console.log(
        `${name} ${label}: ${row.created ? "created" : "updated" in row && row.updated ? "updated" : "unchanged"}`,
      );
    }
  }
  if (result.client.clientSecret !== null) {
    console.log(`client_id=${result.client.clientId}`);
    console.log(`client_secret=${result.client.clientSecret}`);
    console.log("Store the secret now; it is not shown again.");
  }
} finally {
  await connection.close();
}
