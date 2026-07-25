ALTER TABLE "note_jobs" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "note_jobs" ADD COLUMN "discarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "note_jobs" ADD COLUMN "started_at" timestamp with time zone;