CREATE TABLE "note_narration_clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"annotation_id" uuid,
	"voice" text NOT NULL,
	"clip_id" text NOT NULL,
	"kind" text NOT NULL,
	"blob_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"text_hash" text NOT NULL,
	"chars" integer NOT NULL,
	"bytes" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_narration_voice" CHECK ("note_narration_clips"."voice" IN ('jessica', 'george')),
	CONSTRAINT "ck_narration_kind" CHECK ("note_narration_clips"."kind" IN ('overview', 'step'))
);
--> statement-breakpoint
ALTER TABLE "note_narration_clips" ADD CONSTRAINT "note_narration_clips_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_narration_clips" ADD CONSTRAINT "note_narration_clips_annotation_id_note_annotations_id_fk" FOREIGN KEY ("annotation_id") REFERENCES "public"."note_annotations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_narration_clip" ON "note_narration_clips" USING btree ("note_id","voice","clip_id");