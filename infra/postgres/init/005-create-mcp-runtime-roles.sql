-- Runs once when the postgres volume is first created: the restricted logins the Toolbox and the admin MCP serve as. Each server's migrate
-- script grants its login exactly what it needs on its database. On an existing volume, run this file by hand; it is safe to run again, and
-- turns a role a migration created without login into the login.
DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['answerable_toolbox_runtime', 'answerable_admin_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', name, 'answerable');
    ELSE
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', name, 'answerable');
    END IF;
  END LOOP;
END
$$;
