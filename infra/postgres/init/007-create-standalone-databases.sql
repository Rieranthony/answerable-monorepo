-- Runs once when the postgres volume is first created: the standalone server's database, answerable_standalone, its test database,
-- answerable_standalone_test, and their two logins: answerable_standalone_owner, which owns both and migrates them, and
-- answerable_standalone_runtime, the restricted login the server serves as, which the migration provisions. Like the Toolbox's and the admin
-- MCP's databases, they keep Postgres's default privileges, so a test's fresh login connects. @answerable/mcp-postgres's
-- ensureLocalMcpDatabases runs this file on an existing volume, so the tests need no manual step; it is safe to run again by hand with psql.
-- It never changes an existing login.
DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['answerable_standalone_owner', 'answerable_standalone_runtime'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', name, 'answerable');
    END IF;
  END LOOP;
END
$$;
SELECT format('CREATE DATABASE %I OWNER answerable_standalone_owner', name) FROM unnest(ARRAY['answerable_standalone', 'answerable_standalone_test']) AS name
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = name)
\gexec
