-- One-time cutover: the application does not consume retained upstream tokens.
-- Preserve identity bindings, browser sessions and Answerable-issued grants.
-- Run before admitting logins with the new dedicated storage keys configured.
-- Drizzle commits these changes, their audit facts and its migration receipt
-- in one transaction. Re-running the migration runner must not clear new tokens.
LOCK TABLE public.accounts IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
WITH previous AS MATERIALIZED (
  SELECT id, user_id, updated_at,
    access_token IS NOT NULL AS had_access,
    refresh_token IS NOT NULL AS had_refresh,
    id_token IS NOT NULL AS had_id,
    access_token_expires_at IS NOT NULL AS had_access_expiry,
    refresh_token_expires_at IS NOT NULL AS had_refresh_expiry
  FROM public.accounts
  WHERE access_token IS NOT NULL OR refresh_token IS NOT NULL
    OR id_token IS NOT NULL OR access_token_expires_at IS NOT NULL
    OR refresh_token_expires_at IS NOT NULL
), retired AS (
  UPDATE public.accounts account
  SET access_token = NULL, refresh_token = NULL, id_token = NULL,
    access_token_expires_at = NULL, refresh_token_expires_at = NULL,
    updated_at = statement_timestamp()
  FROM previous
  WHERE account.id = previous.id
  RETURNING previous.*, account.updated_at AS retired_at
), facts AS (
  INSERT INTO public.audit_events
    (id, actor_type, actor_id, action, target_type, target_id, outcome,
      reason, schema_version, data)
  SELECT (
    lpad(to_hex(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0')
    || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14, 3)
    || substr(replace(gen_random_uuid()::text, '-', ''), 17, 16)
  )::uuid,
    'system', 'migration:0037_retire_legacy_upstream_tokens',
    'account.upstream_credentials.retired', 'account', id::text, 'success',
    'upstream_storage_cutover', 1,
    jsonb_build_object(
      'userId', user_id,
      'before', jsonb_build_object(
        'accessTokenPresent', had_access, 'refreshTokenPresent', had_refresh,
        'idTokenPresent', had_id, 'accessExpiryPresent', had_access_expiry,
        'refreshExpiryPresent', had_refresh_expiry, 'updatedAt', updated_at),
      'after', jsonb_build_object(
        'accessTokenPresent', false, 'refreshTokenPresent', false,
        'idTokenPresent', false, 'accessExpiryPresent', false,
        'refreshExpiryPresent', false, 'updatedAt', retired_at)
    )
  FROM retired
  RETURNING id, data
)
INSERT INTO public.audit_event_subjects
  (event_id, entity_type, entity_id, relationship, provenance)
SELECT id, 'user', data->>'userId', 'affected', 'recorded' FROM facts;
