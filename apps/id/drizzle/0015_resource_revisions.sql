ALTER TABLE "oauth_resources" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_resources" ADD CONSTRAINT "oauth_resources_revision_check" CHECK ("oauth_resources"."revision" > 0);
--> statement-breakpoint
CREATE TRIGGER oauth_resources_revision_guard BEFORE UPDATE ON oauth_resources
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION touch_client_resource_revision() RETURNS trigger
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
  FOR target IN
    SELECT DISTINCT value FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.resource_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.resource_id END
    ]) AS targets(value) WHERE value IS NOT NULL ORDER BY value
  LOOP
    UPDATE public.oauth_resources
    SET updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE identifier = target;
  END LOOP;
  RETURN NULL;
END;
$$;
