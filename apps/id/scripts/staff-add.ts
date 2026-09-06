import { addStaff } from "../src/bootstrap.ts";
import { createDatabase } from "../src/db/client.ts";
import { loadEnvironment } from "../src/env.ts";

const email = Bun.argv[2];
if (!email) {
  console.error("Usage: bun run staff:add <email>");
  process.exit(2);
}
const environment = loadEnvironment();
const connection = createDatabase(environment);
try {
  const result = await addStaff(connection.db, {
    platformOrganizationSlug: environment.platformOrganizationSlug,
    email,
  });
  console.log(
    `staff ${email.trim().toLowerCase()}: member ${result.member.created ? "created" : "unchanged"}; group membership ${result.groupMember.created ? "created" : "unchanged"}`,
  );
} finally {
  await connection.close();
}
