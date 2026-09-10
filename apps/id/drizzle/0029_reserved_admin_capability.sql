CREATE FUNCTION protect_reserved_admin_capability() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.grant_kind = 'admin_session' AND EXISTS (
    SELECT 1 FROM system_bindings b JOIN oauth_resources r ON r.id = b.resource_id
    WHERE b.organization_id = OLD.organization_id AND r.identifier = OLD.resource
  ) THEN
    RAISE EXCEPTION 'The bound platform capability cannot be removed; change its configuration explicitly'
      USING ERRCODE = '23514', CONSTRAINT = 'reserved_admin_capability';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reserved_admin_capability_guard BEFORE DELETE ON organization_capabilities
FOR EACH ROW EXECUTE FUNCTION protect_reserved_admin_capability();
