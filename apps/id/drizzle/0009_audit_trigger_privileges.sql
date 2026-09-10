-- Only these trigger entry points need privileged inserts into protected tables.
-- Both have fixed search paths and schema-qualified writes from their original migrations.
ALTER FUNCTION record_audit_subjects() SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION reserve_security_identifier() SECURITY DEFINER;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION capture_audit_subjects(audit_events, text), record_audit_subjects(), reserve_security_identifier() FROM PUBLIC;
