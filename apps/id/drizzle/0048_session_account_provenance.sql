ALTER TABLE "sessions" ADD COLUMN "authentication_account_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "upstream_auth_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_upstream_auth_time_check" CHECK ("sessions"."upstream_auth_time" is null or ("sessions"."authentication_account_id" is not null and "sessions"."upstream_auth_time" >= timestamp with time zone '1970-01-01 00:00:00+00' and "sessions"."upstream_auth_time" <= "sessions"."created_at"));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_session_authentication_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.user_id, NEW.created_at, NEW.authentication_organization_id, NEW.authentication_provider_id, NEW.authentication_provider_revision, NEW.authentication_account_id, NEW.upstream_auth_time)
      IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.created_at, OLD.authentication_organization_id, OLD.authentication_provider_id, OLD.authentication_provider_revision, OLD.authentication_account_id, OLD.upstream_auth_time) THEN
      RAISE EXCEPTION 'Session identity and authentication origin are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_immutable';
    END IF;
  ELSIF NEW.authentication_provider_id IS NOT NULL THEN
    PERFORM 1 FROM sso_providers p
      JOIN accounts a ON a.id = NEW.authentication_account_id
        AND a.user_id = NEW.user_id AND a.issuer = p.issuer
        AND a.provider_id = p.provider_id AND a.deleted_at IS NULL
      WHERE p.id = NEW.authentication_provider_id
        AND p.organization_id = NEW.authentication_organization_id
        AND p.revision = NEW.authentication_provider_revision AND p.deleted_at IS NULL
      FOR SHARE OF p, a;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Session authentication origin must match its provider and account'
        USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_provider';
    END IF;
  ELSIF NEW.authentication_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'Session account requires an authentication provider'
      USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_provider';
  END IF;
  RETURN NEW;
END;
$$;
