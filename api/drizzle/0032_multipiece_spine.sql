CREATE TABLE "lesson_pieces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_session_id" uuid NOT NULL,
	"sort_index" integer NOT NULL,
	"piece_id" text,
	"piece_label" text,
	"piece_source" text,
	"custom_piece_id" uuid,
	"score_scan_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_lesson_piece_slot_excludes_scan" CHECK ("lesson_pieces"."piece_id" IS NULL OR "lesson_pieces"."score_scan_id" IS NULL),
	CONSTRAINT "ck_lesson_piece_slot_source" CHECK ("lesson_pieces"."piece_source" IS NULL OR "lesson_pieces"."piece_source" IN ('catalog', 'vendored', 'typed'))
);
--> statement-breakpoint
CREATE TABLE "note_pieces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"sort_index" integer NOT NULL,
	"practice_subject_id" uuid,
	"piece_id" text,
	"piece_label" text,
	"piece_source" text,
	"custom_piece_id" uuid,
	"score_scan_id" uuid,
	"score_scan_detached_at" timestamp with time zone,
	"piece_version" integer,
	"piece_suggestion_dismissed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_note_piece_slot_excludes_scan" CHECK ("note_pieces"."piece_id" IS NULL OR "note_pieces"."score_scan_id" IS NULL),
	CONSTRAINT "ck_note_piece_slot_source" CHECK ("note_pieces"."piece_source" IS NULL OR "note_pieces"."piece_source" IN ('catalog', 'vendored', 'typed'))
);
--> statement-breakpoint
CREATE TABLE "practice_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"teacher_id" uuid NOT NULL,
	"piece_id" text,
	"custom_piece_id" uuid,
	"current_score_scan_id" uuid,
	"current_score_set_by" text,
	"current_score_set_at" timestamp with time zone,
	"target_bpm" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_practice_subject_identity" CHECK (("practice_subjects"."piece_id" IS NULL) <> ("practice_subjects"."custom_piece_id" IS NULL)),
	CONSTRAINT "ck_practice_subject_set_by" CHECK ("practice_subjects"."current_score_set_by" IS NULL OR "practice_subjects"."current_score_set_by" IN ('teacher', 'student'))
);
--> statement-breakpoint
ALTER TABLE "note_annotations" ADD COLUMN "note_piece_id" uuid;--> statement-breakpoint
ALTER TABLE "note_annotations" ADD COLUMN "grounded_piece_id" uuid;--> statement-breakpoint
ALTER TABLE "note_annotations" ADD COLUMN "source" text DEFAULT 'transcript' NOT NULL;--> statement-breakpoint
ALTER TABLE "note_annotations" ADD COLUMN "group_label" text;--> statement-breakpoint
ALTER TABLE "note_annotations" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "lesson_pieces" ADD CONSTRAINT "lesson_pieces_lesson_session_id_lesson_sessions_id_fk" FOREIGN KEY ("lesson_session_id") REFERENCES "public"."lesson_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_pieces" ADD CONSTRAINT "lesson_pieces_piece_id_pieces_id_fk" FOREIGN KEY ("piece_id") REFERENCES "public"."pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_pieces" ADD CONSTRAINT "lesson_pieces_custom_piece_id_custom_pieces_id_fk" FOREIGN KEY ("custom_piece_id") REFERENCES "public"."custom_pieces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_pieces" ADD CONSTRAINT "lesson_pieces_score_scan_id_score_scans_id_fk" FOREIGN KEY ("score_scan_id") REFERENCES "public"."score_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_pieces" ADD CONSTRAINT "note_pieces_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_pieces" ADD CONSTRAINT "note_pieces_practice_subject_id_practice_subjects_id_fk" FOREIGN KEY ("practice_subject_id") REFERENCES "public"."practice_subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_pieces" ADD CONSTRAINT "note_pieces_piece_id_pieces_id_fk" FOREIGN KEY ("piece_id") REFERENCES "public"."pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_pieces" ADD CONSTRAINT "note_pieces_custom_piece_id_custom_pieces_id_fk" FOREIGN KEY ("custom_piece_id") REFERENCES "public"."custom_pieces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_pieces" ADD CONSTRAINT "note_pieces_score_scan_id_score_scans_id_fk" FOREIGN KEY ("score_scan_id") REFERENCES "public"."score_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_subjects" ADD CONSTRAINT "practice_subjects_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_subjects" ADD CONSTRAINT "practice_subjects_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_subjects" ADD CONSTRAINT "practice_subjects_piece_id_pieces_id_fk" FOREIGN KEY ("piece_id") REFERENCES "public"."pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_subjects" ADD CONSTRAINT "practice_subjects_custom_piece_id_custom_pieces_id_fk" FOREIGN KEY ("custom_piece_id") REFERENCES "public"."custom_pieces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_subjects" ADD CONSTRAINT "practice_subjects_current_score_scan_id_score_scans_id_fk" FOREIGN KEY ("current_score_scan_id") REFERENCES "public"."score_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lesson_pieces_order" ON "lesson_pieces" USING btree ("lesson_session_id","sort_index");--> statement-breakpoint
CREATE INDEX "ix_lesson_pieces_scan" ON "lesson_pieces" USING btree ("score_scan_id") WHERE "lesson_pieces"."score_scan_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_note_pieces_order" ON "note_pieces" USING btree ("note_id","sort_index");--> statement-breakpoint
CREATE INDEX "ix_note_pieces_scan" ON "note_pieces" USING btree ("score_scan_id") WHERE "note_pieces"."score_scan_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_note_pieces_subject" ON "note_pieces" USING btree ("practice_subject_id") WHERE "note_pieces"."practice_subject_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_practice_subject_catalog" ON "practice_subjects" USING btree ("student_id","teacher_id","piece_id") WHERE "practice_subjects"."piece_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_practice_subject_custom" ON "practice_subjects" USING btree ("student_id","teacher_id","custom_piece_id") WHERE "practice_subjects"."custom_piece_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "note_annotations" ADD CONSTRAINT "note_annotations_note_piece_id_note_pieces_id_fk" FOREIGN KEY ("note_piece_id") REFERENCES "public"."note_pieces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_annotations" ADD CONSTRAINT "note_annotations_grounded_piece_id_note_pieces_id_fk" FOREIGN KEY ("grounded_piece_id") REFERENCES "public"."note_pieces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_note_annotations_piece" ON "note_annotations" USING btree ("note_piece_id") WHERE "note_annotations"."note_piece_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "note_annotations" ADD CONSTRAINT "ck_practice_item_source" CHECK ("note_annotations"."source" IN ('transcript', 'plan'));--> statement-breakpoint
ALTER TABLE "note_annotations" ADD CONSTRAINT "ck_practice_item_transcript_quoted" CHECK ("note_annotations"."source" <> 'transcript' OR "note_annotations"."quote" IS NOT NULL);