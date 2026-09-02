-- Runs once when the postgres volume is first created.
-- The app database (answerable_id) is created by POSTGRES_DB; tests get their own.
CREATE DATABASE answerable_id_test;
