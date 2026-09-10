ALTER TABLE "members" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_status_check" CHECK ("members"."status" in ('active', 'revoked'));--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_revoked_check" CHECK (("members"."status" = 'revoked') = ("members"."revoked_at" is not null));
--> statement-breakpoint
CREATE FUNCTION protect_member_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Membership identity and tenant are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'members_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER members_identity_guard BEFORE UPDATE ON members
FOR EACH ROW EXECUTE FUNCTION protect_member_identity();
