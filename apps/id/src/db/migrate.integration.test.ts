import { afterAll, expect, spyOn, test } from "bun:test";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { isUuidV7, testEnvironment } from "../__tests__/support.ts";
import { testDatabaseUrl } from "../__tests__/test-database.ts";
import { bootstrap, systemActor } from "../bootstrap.ts";
import { createDatabase } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { configureRuntimeRole } from "./runtime-role.ts";

const connection = createDatabase(testEnvironment());
const committed = fileURLToPath(new URL("../../drizzle", import.meta.url));
const committedCount = readMigrationFiles({
  migrationsFolder: committed,
}).length;
afterAll(() => connection.close());

async function editJournal(
  folder: string,
  edit: (entries: { tag: string; when: number }[]) => void,
) {
  const path = join(folder, "meta/_journal.json");
  const journal = JSON.parse(await readFile(path, "utf8"));
  edit(journal.entries);
  await writeFile(path, JSON.stringify(journal));
}

const receipts = async () =>
  (
    await connection.db.execute(
      sql`select hash, created_at from drizzle.__drizzle_migrations order by id`,
    )
  ).rows;

test.each([
  [
    "an applied file was edited",
    "drizzle/0001_invariants.sql",
    (folder: string) =>
      appendFile(join(folder, "0001_invariants.sql"), "\n-- edited\n"),
  ],
  [
    "an applied file was regenerated with a new journal time",
    "drizzle/0000_initial.sql",
    (folder: string) =>
      editJournal(folder, (entries) => {
        entries[0]!.when += 1;
      }),
  ],
  [
    "an applied file was removed from before a later one",
    "drizzle/0001_invariants.sql",
    (folder: string) =>
      editJournal(folder, (entries) => {
        entries.shift();
      }),
  ],
])("migration refuses, naming the file, when %s", async (_, file, change) => {
  const folder = await mkdtemp(join(tmpdir(), "id-migrations-"));
  try {
    await cp(committed, folder, { recursive: true });
    await change(folder);
    const applied = await receipts();
    await expect(runMigrations(connection.db, folder)).rejects.toThrow(
      `Refusing to migrate: ${file} is not the migration this database applied`,
    );
    expect(await receipts()).toEqual(applied);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test.each([
  ["the last migration", 1],
  ["every migration", committedCount],
])(
  "migration accepts a database that has applied more than the image carries: %s missing",
  async (_, missing) => {
    const folder = await mkdtemp(join(tmpdir(), "id-migrations-"));
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await cp(committed, folder, { recursive: true });
      await editJournal(folder, (entries) => {
        entries.splice(entries.length - missing, missing);
      });
      const applied = await receipts();
      expect(applied).toHaveLength(committedCount);
      expect(await runMigrations(connection.db, folder)).toEqual({
        ahead: true,
      });
      expect(await receipts()).toEqual(applied);
      expect(log.mock.calls).toEqual([
        [
          `The database has applied ${committedCount} migrations and this image carries ${committedCount - missing}; applying nothing.`,
        ],
      ]);
    } finally {
      log.mockRestore();
      await rm(folder, { recursive: true, force: true });
    }
  },
);

test("migration says nothing when the database and the image agree", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await runMigrations(connection.db)).toEqual({ ahead: false });
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test("a database that is ahead still refuses a shared file that changed", async () => {
  const folder = await mkdtemp(join(tmpdir(), "id-migrations-"));
  try {
    await cp(committed, folder, { recursive: true });
    await editJournal(folder, (entries) => {
      entries.pop();
    });
    await appendFile(join(folder, "0000_initial.sql"), "\n-- edited\n");
    const applied = await receipts();
    await expect(runMigrations(connection.db, folder)).rejects.toThrow(
      "Refusing to migrate: drizzle/0000_initial.sql is not the migration this database applied",
    );
    expect(await receipts()).toEqual(applied);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("migrating a database at 0001 leaves its provider rows as they were, as directories", async () => {
  const name = `answerable_id_forward_${crypto.randomUUID().replaceAll("-", "")}`;
  const folder = await mkdtemp(join(tmpdir(), "id-migrations-"));
  const log = spyOn(console, "log").mockImplementation(() => {});
  await connection.pool.query(`create database ${name}`);
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;
  const scratch = createDatabase(
    testEnvironment({ databaseUrl: url.toString() }),
  );
  const rows = async () =>
    (
      await scratch.pool.query<Record<string, unknown>>(
        "select *, xmin::text as tuple_writer from sso_providers order by id",
      )
    ).rows;
  try {
    await cp(committed, folder, { recursive: true });
    await editJournal(folder, (entries) => {
      entries.splice(2);
    });
    expect(await runMigrations(scratch.db, folder)).toEqual({ ahead: false });
    await scratch.pool.query(`
      insert into organizations (id, slug, name) values
        ('00000000-0000-7000-8000-000000000001', 'live', 'Live'),
        ('00000000-0000-7000-8000-000000000002', 'removed', 'Removed');
      insert into sso_providers (id, organization_id, provider_id, issuer, domain, oidc_config, created_at, updated_at) values
        ('00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000001', 'live', 'https://idp.example', 'live.example.com', '{"pkce":true}', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('00000000-0000-7000-8000-000000000004', '00000000-0000-7000-8000-000000000002', 'removed', 'https://idp.example', 'removed.example.com', '{"pkce":true}', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
      update sso_providers set domain = 'moved.example.com', updated_at = '2026-01-03T00:00:00Z'
        where provider_id = 'live';
      update sso_providers set deleted_at = '2026-01-04T00:00:00Z', oidc_config = null
        where provider_id = 'removed';
    `);
    const before = await rows();
    expect(before.map((row) => row.revision)).toEqual([2, 2]);
    expect(before[0]).not.toHaveProperty("kind");

    expect(await runMigrations(scratch.db)).toEqual({ ahead: false });

    // The same tuples: nothing wrote to a row, so no trigger saw one, and a session
    // naming a revision still names the current one.
    expect((await rows()).filter((row) => row.kind === "oidc")).toEqual(
      before.map((row) => ({ ...row, kind: "oidc", enabled: true })),
    );
    expect(await scratch.db.$count(sql`drizzle.__drizzle_migrations`)).toBe(
      committedCount,
    );
  } finally {
    log.mockRestore();
    await scratch.close();
    await connection.pool.query(`drop database ${name} with (force)`);
    await rm(folder, { recursive: true, force: true });
  }
});

const id = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** A database owned by an ordinary login, as a deployment's is, not a superuser, and the
 * restricted runtime login beside it: what RLS and the grants actually bind. */
async function deployedDatabase() {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const name = `answerable_id_deployed_${suffix}`;
  const owner = `id_test_owner_${suffix}`;
  const runtime = `id_test_runtime_${suffix}`;
  const password = crypto.randomUUID().replaceAll("-", "");
  await connection.pool.query(`
    create role ${owner} login password '${password}' nosuperuser nocreatedb nocreaterole nobypassrls;
    create role ${runtime} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  `);
  await connection.pool.query(`create database ${name} owner ${owner}`);
  const login = (username: string) => {
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${name}`;
    url.username = username;
    url.password = password;
    return createDatabase(
      testEnvironment({
        databaseUrl: url.toString(),
        databasePoolMax: 2,
        databaseLockTimeoutMs: 15_000,
      }),
    );
  };
  const schemaOwner = login(owner);
  const runtimeLogin = login(runtime);
  const folder = await mkdtemp(join(tmpdir(), "id-migrations-"));
  await cp(committed, folder, { recursive: true });
  return {
    name,
    owner: schemaOwner,
    runtime: runtimeLogin,
    runtimeRole: runtime,
    /** Migrate only as far as the release before the magic-link rows. */
    async migrateBeforeMagicLinks() {
      await editJournal(folder, (entries) => {
        entries.splice(4);
      });
      await runMigrations(schemaOwner.db, folder);
    },
    /** Migrate only as far as the release before magic-link requests. */
    async migrateBeforeRequests() {
      await editJournal(folder, (entries) => {
        entries.splice(6);
      });
      await runMigrations(schemaOwner.db, folder);
    },
    async close() {
      await runtimeLogin.close();
      await schemaOwner.close();
      await rm(folder, { recursive: true, force: true });
      await connection.pool.query(`drop database ${name} with (force)`);
      await connection.pool.query(`drop role ${owner}; drop role ${runtime};`);
    },
  };
}

// Run by the schema owner, before the column and the triggers exist.
const realRows = `
  insert into organizations (id, slug, name) values
    ('${id(1)}', 'with-directory', 'With directory'),
    ('${id(2)}', 'without-directory', 'Without directory'),
    ('${id(3)}', 'answerable', 'Answerable'),
    ('${id(4)}', 'erased', 'Erased'),
    ('${id(5)}', 'disabled', 'Disabled'),
    ('${id(7)}', 'already-holds-one', 'Already holds one');
  insert into sso_providers (id, organization_id, kind, provider_id, issuer, domain) values
    ('${id(17)}', '${id(7)}', 'magic_link', 'magic-link:${id(7)}', 'urn:answerable:magic-link', 'magic-link.invalid');
  insert into sso_providers (id, organization_id, provider_id, issuer, domain, oidc_config) values
    ('${id(11)}', '${id(1)}', 'with-directory', 'https://idp.example', 'with-directory.example.com', '{"pkce":true}'),
    ('${id(13)}', '${id(3)}', 'answerable', 'https://idp.example', 'answerable.example.com', '{"pkce":true}'),
    ('${id(14)}', '${id(4)}', 'erased', 'https://idp.example', 'erased.example.com', '{"pkce":true}');
  insert into oauth_resources (id, identifier, name, allowed_scopes) values
    ('${id(21)}', 'https://id.example/api/admin', 'Admin', '{}');
  insert into groups (id, organization_id, slug, name) values
    ('${id(22)}', '${id(3)}', 'platform-admins', 'Platform admins');
  insert into system_bindings (name, organization_id, resource_instance_id, group_id) values
    ('platform', '${id(3)}', '${id(21)}', '${id(22)}');
  update sso_providers set domain = 'moved.example.com' where provider_id = 'with-directory';
  update sso_providers set deleted_at = now(), oidc_config = null where provider_id = 'erased';
  update organizations set deleted_at = now(), status = 'disabled', disabled_at = now() where id = '${id(4)}';
  update organizations set status = 'disabled', disabled_at = now() where id = '${id(5)}';
`;

test("migrating from the previous release as the schema owner gives each live organisation its row, off for the platform's", async () => {
  const deployed = await deployedDatabase();
  const directories = async () =>
    (
      await deployed.owner.pool.query<Record<string, unknown>>(
        "select *, xmin::text as tuple_writer from sso_providers where kind = 'oidc' order by id",
      )
    ).rows;
  try {
    await deployed.migrateBeforeMagicLinks();
    await deployed.owner.pool.query(realRows);
    const before = await directories();
    expect(before.map((row) => row.revision)).toEqual([2, 1, 2]);

    expect(await runMigrations(deployed.owner.db)).toEqual({ ahead: false });

    // The directories' tuples are the same, so a session naming a revision still does.
    expect(await directories()).toEqual(
      before.map((row) => ({ ...row, enabled: true })),
    );
    const { rows } = await deployed.owner.pool.query<{
      id: string;
      organization_id: string;
      enabled: boolean;
      provider_id: string;
      issuer: string;
      domain: string;
      oidc_config: string | null;
      revision: number;
      deleted_at: Date | null;
    }>(
      "select * from sso_providers where kind = 'magic_link' order by organization_id",
    );
    expect(rows.map((row) => [row.organization_id, row.enabled])).toEqual([
      [id(1), true],
      [id(2), true],
      [id(3), false],
      [id(5), true],
      [id(7), true],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        provider_id: `magic-link:${row.organization_id}`,
        issuer: "urn:answerable:magic-link",
        domain: "magic-link.invalid",
        oidc_config: null,
        revision: 1,
        deleted_at: null,
      });
      expect(isUuidV7(row.id)).toBe(true);
    }
    // A row that was there already stays the row.
    expect(rows.at(-1)!.id).toBe(id(17));

    // The runtime login, under the owner's real grants: what it creates gets a row through
    // the function the owner owns, and it cannot turn the platform organisation's on.
    await configureRuntimeRole(deployed.owner.db, deployed.runtimeRole);
    await deployed.runtime.pool.query(
      `insert into organizations (id, slug, name) values ('${id(6)}', 'after', 'After')`,
    );
    const made = await deployed.owner.pool.query(
      `select enabled from sso_providers where organization_id = '${id(6)}' and kind = 'magic_link'`,
    );
    expect(made.rows).toEqual([{ enabled: true }]);
    const client = await deployed.runtime.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local answerable.scope = 'platform-write'");
      await expect(
        client.query(
          `update sso_providers set enabled = true where organization_id = '${id(3)}' and kind = 'magic_link'`,
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "sso_providers_platform_magic_link",
      });
    } finally {
      await client.query("rollback");
      client.release();
    }

    // A repeated run has nothing to do.
    expect(await runMigrations(deployed.owner.db)).toEqual({ ahead: false });
    const { rows: counted } = await deployed.owner.pool.query(
      "select count(*)::int as count from sso_providers where kind = 'magic_link'",
    );
    expect(counted).toEqual([{ count: 6 }]);
    // Why the owner's backfill and its SECURITY DEFINER functions pass RLS.
    const { rows: forced } = await deployed.owner.pool.query(
      "select relforcerowsecurity as forced from pg_class where relname = 'sso_providers'",
    );
    expect(forced).toEqual([{ forced: false }]);
  } finally {
    await deployed.close();
  }
}, 30_000);

test("migrating real rows from the release before requests touches them, and the runtime login reaches a request only through its scope", async () => {
  const deployed = await deployedDatabase();
  const tuples = async () =>
    (
      await deployed.owner.pool.query<Record<string, unknown>>(`
        select 'organizations' as source, id::text, xmin::text as tuple_writer from organizations
        union all select 'sso_providers', id::text, xmin::text from sso_providers
        union all select 'users', id::text, xmin::text from users
        union all select 'members', id::text, xmin::text from members
        union all select 'domains', id::text, xmin::text from organization_domains
        order by 1, 2`)
    ).rows;
  const newRequest = (organization: string, provider: string) =>
    `insert into magic_link_requests (id, organization_id, provider_id, provider_revision, purpose, email, client_hash, expires_at)
     values ('${Bun.randomUUIDv7()}', '${organization}', '${provider}', 1, 'access_removed', 'person@one.example.com', 'client', now())`;
  try {
    await deployed.migrateBeforeRequests();
    await deployed.owner.pool.query(`
      insert into organizations (id, slug, name) values
        ('${id(1)}', 'one', 'One'), ('${id(2)}', 'two', 'Two');
      insert into organization_domains (id, organization_id, domain) values
        ('${id(3)}', '${id(1)}', 'one.example.com');
      insert into users (id, name, email, status) values
        ('${id(4)}', 'Person', 'person@one.example.com', 'active');
      insert into members (id, organization_id, user_id) values
        ('${id(5)}', '${id(1)}', '${id(4)}');
    `);
    const before = await tuples();
    expect(before).toHaveLength(7);
    const { rows: missing } = await deployed.owner.pool.query(
      "select to_regclass('magic_link_requests') as found",
    );
    expect(missing).toEqual([{ found: null }]);

    expect(await runMigrations(deployed.owner.db)).toEqual({ ahead: false });
    expect(await tuples()).toEqual(before);
    await configureRuntimeRole(deployed.owner.db, deployed.runtimeRole);

    const { rows: providers } = await deployed.owner.pool.query<{
      id: string;
      organization_id: string;
    }>(
      "select id, organization_id from sso_providers where kind = 'magic_link' order by organization_id",
    );
    const [first, second] = providers;
    const client = await deployed.runtime.pool.connect();
    const scoped = async (scope: string, tenant: string, statement: string) => {
      await client.query("begin");
      try {
        await client.query(
          `select set_config('answerable.scope', $1, true), set_config('answerable.tenant', $2, true)`,
          [scope, tenant],
        );
        return await client.query(statement);
      } finally {
        await client.query("rollback");
      }
    };
    try {
      // With no scope the runtime login reads nothing and writes nothing.
      await deployed.owner.pool.query(newRequest(id(1), first!.id));
      expect(
        (await client.query("select * from magic_link_requests")).rows,
      ).toEqual([]);
      await expect(
        client.query(newRequest(id(1), first!.id)),
      ).rejects.toMatchObject({ code: "42501" });

      // Protocol scope does both, and the sweep's delete is granted.
      expect(
        (await scoped("protocol", "", "select * from magic_link_requests"))
          .rows,
      ).toHaveLength(1);
      await scoped("protocol", "", newRequest(id(2), second!.id));
      expect(
        (await scoped("protocol", "", "delete from magic_link_requests"))
          .rowCount,
      ).toBe(1);

      // A firm reads its own, and not another's.
      expect(
        (
          await scoped(
            "tenant-read",
            id(1),
            "select * from magic_link_requests",
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await scoped(
            "tenant-read",
            id(2),
            "select * from magic_link_requests",
          )
        ).rows,
      ).toEqual([]);
    } finally {
      client.release();
    }

    // A repeated run has nothing to do, and the grants stay.
    expect(await runMigrations(deployed.owner.db)).toEqual({ ahead: false });
    expect(await tuples()).toEqual(before);
  } finally {
    await deployed.close();
  }
}, 30_000);

test("a first start on a fresh database under the deployed logins leaves the platform organisation off", async () => {
  const deployed = await deployedDatabase();
  try {
    await runMigrations(deployed.owner.db);
    await configureRuntimeRole(deployed.owner.db, deployed.runtimeRole);
    const { organizationId } = await bootstrap(
      deployed.runtime.db,
      systemActor("deployed-first-start"),
      {
        platformOrganizationSlug: "answerable",
        platformOrganizationName: "Answerable",
        adminResourceIdentifier: "https://id.example/api/admin",
      },
    );
    const { rows } = await deployed.owner.pool.query(
      `select enabled, revision from sso_providers where organization_id = '${organizationId}' and kind = 'magic_link'`,
    );
    expect(rows).toEqual([{ enabled: false, revision: 2 }]);
  } finally {
    await deployed.close();
  }
}, 30_000);

test("an organisation being created while the migration runs gets its row", async () => {
  const deployed = await deployedDatabase();
  const creating = await deployed.owner.pool.connect();
  try {
    await deployed.migrateBeforeMagicLinks();
    await creating.query("begin");
    await creating.query(
      `insert into organizations (id, slug, name) values ('${id(1)}', 'in-flight', 'In flight')`,
    );
    // Once the migration is waiting on this transaction, it commits. A backfill ahead of
    // the trigger would already have passed this organisation by.
    const migrating = runMigrations(deployed.owner.db);
    for (let wait = 0; wait < 1000; wait++) {
      const { rows } = await connection.pool.query(
        "select 1 from pg_stat_activity where datname = $1 and wait_event_type = 'Lock'",
        [deployed.name],
      );
      if (rows.length) break;
      await Bun.sleep(10);
    }
    await creating.query("commit");
    expect(await migrating).toEqual({ ahead: false });
    const { rows } = await deployed.owner.pool.query(
      `select enabled from sso_providers where organization_id = '${id(1)}' and kind = 'magic_link'`,
    );
    expect(rows).toEqual([{ enabled: true }]);
  } finally {
    creating.release();
    await deployed.close();
  }
}, 30_000);
