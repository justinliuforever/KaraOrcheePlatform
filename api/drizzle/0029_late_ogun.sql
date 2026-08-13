UPDATE "notes" SET "score_scan_id" = NULL WHERE "piece_id" IS NOT NULL AND "score_scan_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "ck_note_piece_excludes_scan" CHECK ("notes"."piece_id" IS NULL OR "notes"."score_scan_id" IS NULL);
