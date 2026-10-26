-- Runs once when the postgres volume is first created: the shared database of every MCP's schema, answerable_mcps, its test database,
-- answerable_mcps_test, and their two logins: the migrator, which owns both, and the Toolbox's serving login, answerable_mcps_toolbox.
-- A volume made before this file runs it once by hand with psql, as the Toolbox's docs show (Database roles); it is safe to run again. It never
-- changes an existing login.
DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['answerable_mcps_migrator', 'answerable_mcps_toolbox'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', name, 'answerable');
    END IF;
  END LOOP;
END
$$;
SELECT format('CREATE DATABASE %I OWNER answerable_mcps_migrator', name) FROM unnest(ARRAY['answerable_mcps', 'answerable_mcps_test']) AS name
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = name)
\gexec
REVOKE ALL ON DATABASE answerable_mcps, answerable_mcps_test FROM PUBLIC;
GRANT CONNECT ON DATABASE answerable_mcps, answerable_mcps_test TO answerable_mcps_migrator, answerable_mcps_toolbox;
REVOKE TEMPORARY ON DATABASE answerable_mcps, answerable_mcps_test FROM answerable_mcps_toolbox;
