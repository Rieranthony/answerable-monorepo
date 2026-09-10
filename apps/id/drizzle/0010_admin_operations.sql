CREATE TABLE "admin_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_instance" text NOT NULL,
	"authority_scope" text NOT NULL,
	"name" text NOT NULL,
	"key_digest" text NOT NULL,
	"fingerprint" text NOT NULL,
	"outcome" text NOT NULL,
	"status_code" integer NOT NULL,
	"result_reference" jsonb NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_operations_key_unique" UNIQUE("actor_instance","authority_scope","name","key_digest"),
	CONSTRAINT "admin_operations_outcome_check" CHECK ("admin_operations"."outcome" in ('applied', 'noop'))
);

--> statement-breakpoint
CREATE FUNCTION protect_admin_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Completed operations are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'admin_operations_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER admin_operations_immutable BEFORE UPDATE OR DELETE ON admin_operations
FOR EACH ROW EXECUTE FUNCTION protect_admin_operation();
