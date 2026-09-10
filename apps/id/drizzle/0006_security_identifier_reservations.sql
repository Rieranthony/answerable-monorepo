CREATE TABLE "security_identifiers" (
	"kind" text NOT NULL,
	"identifier" text NOT NULL,
	"instance_id" uuid NOT NULL,
	CONSTRAINT "security_identifiers_kind_identifier_pk" PRIMARY KEY("kind","identifier"),
	CONSTRAINT "security_identifiers_kind_instance_unique" UNIQUE("kind","instance_id"),
	CONSTRAINT "security_identifiers_kind_check" CHECK ("security_identifiers"."kind" in ('client', 'resource'))
);
--> statement-breakpoint
INSERT INTO security_identifiers (kind, identifier, instance_id)
SELECT 'client', client_id, id FROM oauth_clients
UNION ALL SELECT 'resource', identifier, id FROM oauth_resources;
--> statement-breakpoint
CREATE FUNCTION reserve_security_identifier() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'oauth_clients' THEN
    INSERT INTO public.security_identifiers (kind, identifier, instance_id)
    VALUES ('client', NEW.client_id, NEW.id);
  ELSE
    INSERT INTO public.security_identifiers (kind, identifier, instance_id)
    VALUES ('resource', NEW.identifier, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER oauth_clients_reserve_identity AFTER INSERT ON oauth_clients
FOR EACH ROW EXECUTE FUNCTION reserve_security_identifier();
--> statement-breakpoint
CREATE TRIGGER oauth_resources_reserve_identity AFTER INSERT ON oauth_resources
FOR EACH ROW EXECUTE FUNCTION reserve_security_identifier();
--> statement-breakpoint
CREATE FUNCTION protect_security_identifier() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Security identifier reservations are permanent'
    USING ERRCODE = '23514', CONSTRAINT = 'security_identifiers_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER security_identifiers_immutable BEFORE UPDATE OR DELETE ON security_identifiers
FOR EACH ROW EXECUTE FUNCTION protect_security_identifier();
