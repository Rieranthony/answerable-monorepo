-- Runs once when the postgres volume is first created: the admin MCP's database and its test database, and the test database of @answerable/mcp-postgres.
CREATE DATABASE answerable_admin;
CREATE DATABASE answerable_admin_test;
CREATE DATABASE answerable_mcp_postgres_test;
