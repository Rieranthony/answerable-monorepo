-- The capabilities the Toolbox serves, as their providers' manifests describe them, and which providers each organisation may use.

create table providers (
  id text primary key,
  version text not null,
  manifest jsonb not null,
  registered_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'retired'))
);

create table capabilities (
  provider_id text not null references providers (id),
  identity text not null,
  version text not null,
  kind text not null check (kind in ('read', 'mutate')),
  risk text check (risk in ('low', 'normal', 'high')),
  policy_class_default text check (policy_class_default in ('agent', 'controlled', 'human')),
  title text,
  description text not null,
  input jsonb not null,
  output jsonb not null,
  -- Identity first, then title, then description, then the names of the input's arguments.
  search tsvector generated always as (
    setweight(to_tsvector('simple', translate(identity, '/.', '  ')), 'A')
    || setweight(to_tsvector('english', coalesce(title, '')), 'B')
    || setweight(to_tsvector('english', description), 'C')
    || setweight(jsonb_to_tsvector('simple', jsonb_path_query_array(input, '$.properties.keyvalue().key'), '["string"]'), 'D')
  ) stored,
  status text not null default 'active' check (status in ('active', 'retired')),
  primary key (identity, version),
  check ((kind = 'mutate') = (risk is not null and policy_class_default is not null))
);

create index capabilities_search on capabilities using gin (search);

create table organisation_catalogue (
  organisation_id uuid not null,
  provider_id text not null references providers (id),
  enabled boolean not null default false,
  overrides jsonb not null default '{"disabled": [], "policy_class": {}}',
  updated_at timestamptz not null default now(),
  primary key (organisation_id, provider_id)
);
