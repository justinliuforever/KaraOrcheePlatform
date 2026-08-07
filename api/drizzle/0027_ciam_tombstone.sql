ALTER TABLE "users" ADD COLUMN "ciam_oid_at_delete" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ciam_deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ix_users_ciam_oid_at_delete" ON "users" USING btree ("ciam_oid_at_delete") WHERE "users"."ciam_oid_at_delete" IS NOT NULL;