-- How the Toolbox serves each host: the OAuth client of the token names the row. A client without a row gets the defaults.

create table host_clients (
  client_id text primary key,
  projection text not null default 'auto' check (projection in ('direct', 'meta', 'auto')),
  direct_limit integer not null default 40 check (direct_limit > 0)
);
