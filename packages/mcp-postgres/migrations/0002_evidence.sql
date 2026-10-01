-- The Toolbox's evidence: an append-only chain of events per organisation, and erasable payloads that the chain holds only by hash.

create table evidence_payloads (
  id uuid primary key,
  organisation_id uuid not null,
  body jsonb,
  hash text not null,
  created_at timestamptz not null default now(),
  erased_at timestamptz,
  check ((body is null) = (erased_at is not null))
);

create table evidence_events (
  id uuid primary key,
  organisation_id uuid not null,
  seq bigint not null,
  occurred_at timestamptz not null default now(),
  kind text not null check (kind in (
    'capability.requested', 'capability.completed', 'capability.denied', 'intent.prepared', 'intent.approval_requested', 'intent.approved',
    'intent.denied', 'intent.committed', 'intent.stale', 'intent.expired', 'receipt.issued', 'operation.started', 'operation.finished',
    'run.started', 'run.finished', 'limit.refused'
  )),
  actor_type text not null,
  actor_id text not null,
  on_behalf_of text,
  client_id text,
  capability_identity text,
  capability_version text,
  execution_id uuid,
  intent_id uuid,
  receipt_id uuid,
  operation_id uuid,
  upstream text,
  target_type text,
  target_id text,
  outcome text not null check (outcome in ('success', 'failure', 'denied')),
  reason text,
  error_code text,
  request_id text,
  trace_id text,
  span_id text,
  data jsonb not null default '{}' check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 4096),
  payload_ref uuid references evidence_payloads (id),
  payload_hash text,
  prev_hash text not null,
  row_hash text not null,
  schema_version integer not null default 1,
  unique (organisation_id, seq)
);

-- One field of the chained text: "~" for null, else its length in UTF-8 bytes, ":" and the text.
create function evidence_field(value text) returns text language sql immutable as $$
  select case when value is null then '~' else octet_length(convert_to(value, 'UTF8'))::text || ':' || value end
$$;

-- row_hash is the lower-case hex SHA-256 of the UTF-8 bytes of prev_hash followed by evidence_field of each column below, in this order:
--   schema_version, organisation_id, seq, id, occurred_at, kind, actor_type, actor_id, on_behalf_of, client_id, capability_identity,
--   capability_version, execution_id, intent_id, receipt_id, operation_id, upstream, target_type, target_id, outcome, reason, error_code,
--   request_id, trace_id, span_id, data, payload_ref, payload_hash
-- as text: integers in decimal, UUIDs in lower case with hyphens, occurred_at in UTC as YYYY-MM-DDTHH:MI:SS.ffffffZ, data as Postgres prints jsonb.
-- An organisation's first event has seq 1 and a prev_hash of 64 zeros. verify in src/evidence.ts recomputes it the same way.
create function evidence_chain() returns trigger language plpgsql as $$
declare
  last_seq bigint;
  last_hash text;
begin
  perform pg_advisory_xact_lock(hashtext(new.organisation_id::text));
  select seq, row_hash into last_seq, last_hash from evidence_events where organisation_id = new.organisation_id order by seq desc limit 1;
  new.seq := coalesce(last_seq, 0) + 1;
  new.prev_hash := coalesce(last_hash, repeat('0', 64));
  new.row_hash := encode(sha256(convert_to(new.prev_hash
    || evidence_field(new.schema_version::text) || evidence_field(new.organisation_id::text) || evidence_field(new.seq::text)
    || evidence_field(new.id::text) || evidence_field(to_char(new.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    || evidence_field(new.kind) || evidence_field(new.actor_type) || evidence_field(new.actor_id) || evidence_field(new.on_behalf_of)
    || evidence_field(new.client_id) || evidence_field(new.capability_identity) || evidence_field(new.capability_version)
    || evidence_field(new.execution_id::text) || evidence_field(new.intent_id::text) || evidence_field(new.receipt_id::text)
    || evidence_field(new.operation_id::text) || evidence_field(new.upstream) || evidence_field(new.target_type) || evidence_field(new.target_id)
    || evidence_field(new.outcome) || evidence_field(new.reason) || evidence_field(new.error_code) || evidence_field(new.request_id)
    || evidence_field(new.trace_id) || evidence_field(new.span_id) || evidence_field(new.data::text) || evidence_field(new.payload_ref::text)
    || evidence_field(new.payload_hash), 'UTF8')), 'hex');
  return new;
end
$$;

create trigger evidence_chain before insert on evidence_events for each row execute function evidence_chain();

create function evidence_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'evidence_events is append-only: % is refused', tg_op;
end
$$;

create trigger evidence_append_only before update or delete on evidence_events for each row execute function evidence_append_only();
create trigger evidence_no_truncate before truncate on evidence_events for each statement execute function evidence_append_only();
