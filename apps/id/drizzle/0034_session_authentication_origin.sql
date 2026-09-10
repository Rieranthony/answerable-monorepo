ALTER TABLE "sessions" ADD COLUMN "authentication_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "authentication_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "authentication_provider_revision" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_authentication_origin_check" CHECK (
      ("sessions"."authentication_organization_id" is null and "sessions"."authentication_provider_id" is null and "sessions"."authentication_provider_revision" is null)
      or ("sessions"."authentication_organization_id" is not null and "sessions"."authentication_provider_id" is not null and "sessions"."authentication_provider_revision" is not null and "sessions"."authentication_provider_revision" > 0)
    );--> statement-breakpoint
CREATE FUNCTION protect_session_authentication_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.user_id, NEW.created_at, NEW.authentication_organization_id, NEW.authentication_provider_id, NEW.authentication_provider_revision)
      IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.created_at, OLD.authentication_organization_id, OLD.authentication_provider_id, OLD.authentication_provider_revision) THEN
      RAISE EXCEPTION 'Session identity and authentication origin are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_immutable';
    END IF;
  ELSIF NEW.authentication_provider_id IS NOT NULL THEN
    PERFORM 1 FROM sso_providers p
      WHERE p.id = NEW.authentication_provider_id
        AND p.organization_id = NEW.authentication_organization_id
        AND p.revision = NEW.authentication_provider_revision
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Session authentication origin must match its provider'
        USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_provider';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sessions_authentication_origin_guard BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION protect_session_authentication_origin();
