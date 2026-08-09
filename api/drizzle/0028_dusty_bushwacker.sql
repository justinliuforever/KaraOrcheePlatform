CREATE TABLE "score_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"client_scan_id" text,
	"page_count" integer NOT NULL,
	"blob_prefix" text,
	"bytes" integer,
	"status" text DEFAULT 'created' NOT NULL,
	"taken_down_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_score_scans_status" CHECK ("score_scans"."status" IN ('created', 'ready', 'taken_down')),
	CONSTRAINT "ck_score_scans_pages" CHECK ("score_scans"."page_count" BETWEEN 1 AND 20)
);
--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "score_scan_id" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "score_scan_detached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "score_scans" ADD CONSTRAINT "score_scans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_score_scans_owner_client" ON "score_scans" USING btree ("owner_id","client_scan_id");--> statement-breakpoint
CREATE INDEX "ix_score_scans_owner_created" ON "score_scans" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_score_scan_id_score_scans_id_fk" FOREIGN KEY ("score_scan_id") REFERENCES "public"."score_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_notes_score_scan" ON "notes" USING btree ("score_scan_id") WHERE "notes"."score_scan_id" IS NOT NULL;