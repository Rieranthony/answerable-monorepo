ALTER TABLE "oauth_clients" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_revision_check" CHECK ("oauth_clients"."revision" > 0);
--> statement-breakpoint
CREATE FUNCTION protect_configuration_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'Configuration revision is server controlled'
      USING ERRCODE = '23514', CONSTRAINT = 'configuration_revision_server_controlled';
  END IF;
  IF (to_jsonb(NEW) - 'revision') IS DISTINCT FROM (to_jsonb(OLD) - 'revision') THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER oauth_clients_revision_guard BEFORE UPDATE ON oauth_clients
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE FUNCTION touch_client_resource_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE target text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.client_id = OLD.client_id AND NEW.resource_id = OLD.resource_id THEN
    RETURN NULL;
  END IF;
  FOR target IN
    SELECT DISTINCT value FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.client_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.client_id END
    ]) AS targets(value) WHERE value IS NOT NULL ORDER BY value
  LOOP
    UPDATE public.oauth_clients
    SET updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE client_id = target;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER oauth_client_resources_revision AFTER INSERT OR UPDATE OR DELETE ON oauth_client_resources
FOR EACH ROW EXECUTE FUNCTION touch_client_resource_revision();
