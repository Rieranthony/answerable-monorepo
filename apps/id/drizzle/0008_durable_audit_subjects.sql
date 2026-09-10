CREATE TABLE "audit_event_subjects" (
	"event_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"relationship" text NOT NULL,
	"organization_id" uuid,
	"provenance" text DEFAULT 'recorded' NOT NULL,
	CONSTRAINT "audit_event_subjects_event_id_entity_type_entity_id_relationship_pk" PRIMARY KEY("event_id","entity_type","entity_id","relationship"),
	CONSTRAINT "audit_event_subjects_provenance_check" CHECK ("audit_event_subjects"."provenance" in ('recorded', 'legacy_derived'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_event_subjects" ADD CONSTRAINT "audit_event_subjects_event_id_audit_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."audit_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_subjects_entity_idx" ON "audit_event_subjects" USING btree ("entity_type","entity_id","event_id");--> statement-breakpoint
CREATE INDEX "audit_event_subjects_tenant_entity_idx" ON "audit_event_subjects" USING btree ("organization_id","entity_type","entity_id","event_id");--> statement-breakpoint
CREATE FUNCTION capture_audit_subjects(event public.audit_events, origin text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE related_user text;
BEGIN
  INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
  VALUES (event.id, event.actor_type, event.actor_id, 'actor', event.organization_id, origin);
  IF event.target_id IS NOT NULL THEN
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (event.id, event.target_type, event.target_id, 'target', event.organization_id, origin);
  END IF;
  IF event.target_type IN ('member', 'group_member') THEN
    SELECT user_id::text INTO related_user FROM public.members
    WHERE id::text = event.target_id AND (event.organization_id IS NULL OR organization_id = event.organization_id);
    related_user := coalesce(related_user, event.data->>'userId');
  ELSIF event.target_type = 'session' THEN
    SELECT user_id::text INTO related_user FROM public.sessions WHERE id::text = event.target_id;
    related_user := coalesce(related_user, event.data->>'userId');
  END IF;
  IF related_user IS NOT NULL THEN
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (event.id, 'user', related_user, 'affected', event.organization_id, origin);
  END IF;
END;
$$;
--> statement-breakpoint
SELECT capture_audit_subjects(event, 'legacy_derived') FROM audit_events event;
--> statement-breakpoint
CREATE FUNCTION record_audit_subjects() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.capture_audit_subjects(NEW, 'recorded');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_capture_subjects AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION record_audit_subjects();
