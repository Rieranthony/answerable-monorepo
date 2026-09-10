ALTER TABLE "audit_events" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "schema_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_operation_id_admin_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."admin_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_operation_id_idx" ON "audit_events" USING btree ("operation_id");
--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "schema_version" SET DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "audit_events" ALTER CONSTRAINT "audit_events_operation_id_admin_operations_id_fk" DEFERRABLE INITIALLY DEFERRED;
