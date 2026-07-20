ALTER TABLE "lesson_sessions" ADD COLUMN "client_lesson_id" text;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD CONSTRAINT "uq_lesson_client_id" UNIQUE("teacher_id","client_lesson_id");