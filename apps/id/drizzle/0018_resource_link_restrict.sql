ALTER TABLE "oauth_client_resources" DROP CONSTRAINT "oauth_client_resources_resource_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resources"("identifier") ON DELETE restrict ON UPDATE no action;