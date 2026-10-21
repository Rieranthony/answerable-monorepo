-- The evidence chain: what drizzle cannot express. One field of the chained text: "~" for null, else its length in UTF-8 bytes, ":" and the text.
CREATE FUNCTION evidence_field(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  select case when value is null then '~' else octet_length(convert_to(value, 'UTF8'))::text || ':' || value end
$$;
--> statement-breakpoint
-- row_hash is the lower-case hex SHA-256 of the UTF-8 bytes of prev_hash followed by evidence_field of each column below, in this order:
--   schema_version, organisation_id, seq, id, occurred_at, kind, actor_type, actor_id, client_id, capability_identity, capability_version,
--   execution_id, intent_id, receipt_id, upstream, outcome, reason, error_code, request_id, trace_id, span_id, data, payload_ref, payload_hash
-- as text: integers in decimal, UUIDs in lower case with hyphens, occurred_at in UTC as YYYY-MM-DDTHH:MI:SS.ffffffZ, data as Postgres prints jsonb.
-- An organisation's first event has seq 1 and a prev_hash of 64 zeros. verify in src/evidence.ts recomputes it the same way.
CREATE FUNCTION evidence_chain() RETURNS trigger LANGUAGE plpgsql AS $$
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
    || evidence_field(new.kind) || evidence_field(new.actor_type) || evidence_field(new.actor_id) || evidence_field(new.client_id)
    || evidence_field(new.capability_identity) || evidence_field(new.capability_version) || evidence_field(new.execution_id::text)
    || evidence_field(new.intent_id::text) || evidence_field(new.receipt_id::text) || evidence_field(new.upstream) || evidence_field(new.outcome)
    || evidence_field(new.reason) || evidence_field(new.error_code) || evidence_field(new.request_id) || evidence_field(new.trace_id)
    || evidence_field(new.span_id) || evidence_field(new.data::text) || evidence_field(new.payload_ref::text) || evidence_field(new.payload_hash), 'UTF8')), 'hex');
  return new;
end
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_chain BEFORE INSERT ON evidence_events FOR EACH ROW EXECUTE FUNCTION evidence_chain();
--> statement-breakpoint
CREATE FUNCTION evidence_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
begin
  raise exception 'evidence_events is append-only: % is refused', tg_op;
end
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_append_only BEFORE UPDATE OR DELETE ON evidence_events FOR EACH ROW EXECUTE FUNCTION evidence_append_only();
--> statement-breakpoint
CREATE TRIGGER evidence_no_truncate BEFORE TRUNCATE ON evidence_events FOR EACH STATEMENT EXECUTE FUNCTION evidence_append_only();
--> statement-breakpoint
-- A payload changes once: its body erased, with erased_at set and every other column kept.
CREATE FUNCTION evidence_payload_erase_only() RETURNS trigger LANGUAGE plpgsql AS $$
begin
  if tg_op = 'UPDATE' then
    if old.body is not null and new.body is null and new.erased_at is not null
      and (new.id, new.organisation_id, new.hash, new.created_at) = (old.id, old.organisation_id, old.hash, old.created_at) then
      return new;
    end if;
  end if;
  raise exception 'evidence_payloads only erases a body: % is refused', tg_op;
end
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_payload_erase_only BEFORE UPDATE OR DELETE ON evidence_payloads FOR EACH ROW EXECUTE FUNCTION evidence_payload_erase_only();
--> statement-breakpoint
CREATE TRIGGER evidence_payload_no_truncate BEFORE TRUNCATE ON evidence_payloads FOR EACH STATEMENT EXECUTE FUNCTION evidence_payload_erase_only();
