CREATE TABLE "admin_operation_results" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_operations" ADD COLUMN "replay_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_operation_results" ADD CONSTRAINT "admin_operation_results_operation_id_admin_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."admin_operations"("id") ON DELETE restrict ON UPDATE no action;