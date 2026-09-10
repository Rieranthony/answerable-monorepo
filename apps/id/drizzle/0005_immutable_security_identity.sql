CREATE FUNCTION protect_oauth_client_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Client identity and ownership are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'oauth_clients_identity_immutable';
  END IF;
  IF NEW.authorization_version < OLD.authorization_version THEN
    RAISE EXCEPTION 'Client authorization version cannot decrease'
      USING ERRCODE = '23514', CONSTRAINT = 'oauth_clients_version_monotonic';
  END IF;
  IF NEW.client_secret IS DISTINCT FROM OLD.client_secret
     OR NEW.jwks IS DISTINCT FROM OLD.jwks
     OR NEW.jwks_uri IS DISTINCT FROM OLD.jwks_uri
     OR NEW.token_endpoint_auth_method IS DISTINCT FROM OLD.token_endpoint_auth_method
     OR (NEW.disabled AND NOT OLD.disabled) THEN
    NEW.authorization_version := greatest(NEW.authorization_version, OLD.authorization_version + 1);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER oauth_clients_identity_guard BEFORE UPDATE ON oauth_clients
FOR EACH ROW EXECUTE FUNCTION protect_oauth_client_identity();
--> statement-breakpoint
CREATE FUNCTION protect_oauth_resource_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.identifier IS DISTINCT FROM OLD.identifier THEN
    RAISE EXCEPTION 'Resource identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'oauth_resources_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER oauth_resources_identity_guard BEFORE UPDATE ON oauth_resources
FOR EACH ROW EXECUTE FUNCTION protect_oauth_resource_identity();
