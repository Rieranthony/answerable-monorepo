-- The capabilities the Toolbox serves, as their providers' manifests describe them, which providers each organisation may use, and how the
-- Toolbox serves each host.

-- The providers mounted at some boot; the manifest in process is the source of truth, so a row only anchors the foreign keys below.
create table providers (
  id text primary key
);

create table capabilities (
  provider_id text not null references providers (id),
  identity text not null,
  version text not null,
  kind text not null check (kind in ('read', 'mutate')),
  risk text check (risk in ('low', 'normal', 'high')),
  title text,
  description text not null,
  input jsonb not null,
  output jsonb not null,
  -- Identity first, then title, then description, then the names of the input's arguments. Not indexed: the table is small enough to scan.
  search tsvector generated always as (
    setweight(to_tsvector('simple', translate(identity, '/.', '  ')), 'A')
    || setweight(to_tsvector('english', coalesce(title, '')), 'B')
    || setweight(to_tsvector('english', description), 'C')
    || setweight(jsonb_to_tsvector('simple', jsonb_path_query_array(input, '$.properties.keyvalue().key'), '["string"]'), 'D')
  ) stored,
  primary key (identity, version),
  check ((kind = 'mutate') = (risk is not null))
);

create table organisation_catalogue (
  organisation_id uuid not null,
  provider_id text not null references providers (id),
  enabled boolean not null default false,
  overrides jsonb not null default '{"disabled": [], "policy_class": {}}',
  updated_at timestamptz not null default now(),
  primary key (organisation_id, provider_id)
);

-- The OAuth client of the token names the row. A client without a row gets the defaults.
create table host_clients (
  client_id text primary key,
  projection text not null default 'auto' check (projection in ('direct', 'meta', 'auto')),
  direct_limit integer not null default 40 check (direct_limit > 0)
);
