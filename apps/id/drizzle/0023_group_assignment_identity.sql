ALTER TABLE "group_members" ADD COLUMN "id" uuid;--> statement-breakpoint
-- Backfill UUIDv7 identifiers once; runtime inserts still require application IDs.
-- Use the migration time for the 48-bit timestamp and random UUID bits for entropy.
UPDATE "group_members" SET "id" = (
  lpad(to_hex(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0')
  || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14, 3)
  || substr(replace(gen_random_uuid()::text, '-', ''), 17, 16)
)::uuid;--> statement-breakpoint
ALTER TABLE "group_members" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "group_members" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_revision_check" CHECK ("group_members"."revision" > 0);
--> statement-breakpoint
CREATE FUNCTION protect_group_assignment_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    RAISE EXCEPTION 'Group assignment identity and ownership are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'group_members_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER group_members_identity_guard BEFORE UPDATE ON group_members
FOR EACH ROW EXECUTE FUNCTION protect_group_assignment_identity();
--> statement-breakpoint
CREATE TRIGGER group_members_revision_guard BEFORE UPDATE ON group_members
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
