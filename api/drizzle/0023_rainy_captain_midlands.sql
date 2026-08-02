ALTER TABLE "invites" ADD COLUMN "intended_label" text;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teacher_student_links" ADD COLUMN "rejoined_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ix_invites_issuer_direction" ON "invites" USING btree ("teacher_id","direction");--> statement-breakpoint
CREATE INDEX "ix_lesson_sessions_teacher_student_started" ON "lesson_sessions" USING btree ("teacher_id","student_id","started_at");--> statement-breakpoint
CREATE INDEX "ix_note_annotations_note" ON "note_annotations" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "ix_notes_teacher_student_sent" ON "notes" USING btree ("teacher_id","student_id","sent_at");--> statement-breakpoint
CREATE INDEX "ix_notes_student_sent" ON "notes" USING btree ("student_id","sent_at");