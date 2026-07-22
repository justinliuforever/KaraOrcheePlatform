ALTER TABLE "notes" ALTER COLUMN "note_job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "lesson_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "direction" text DEFAULT 'teacher_to_student' NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "owner_role" text DEFAULT 'teacher' NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "origin" text DEFAULT 'teacher' NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "ck_invite_direction" CHECK ("invites"."direction" IN ('teacher_to_student', 'student_to_teacher'));--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD CONSTRAINT "ck_lesson_owner_role" CHECK ("lesson_sessions"."owner_role" IN ('teacher', 'student'));--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "ck_note_origin" CHECK ("notes"."origin" IN ('teacher', 'self'));