CREATE TABLE "custom_pieces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"display_label" text NOT NULL,
	"normalized_label" text NOT NULL,
	"linked_piece_id" text,
	"linked_at" timestamp with time zone,
	"dismissed_piece_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "custom_piece_id" uuid;--> statement-breakpoint
ALTER TABLE "note_jobs" ADD COLUMN "piece_mentions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "custom_piece_id" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "piece_suggestion_dismissed" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_pieces" ADD CONSTRAINT "custom_pieces_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_pieces" ADD CONSTRAINT "custom_pieces_linked_piece_id_pieces_id_fk" FOREIGN KEY ("linked_piece_id") REFERENCES "public"."pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custom_pieces_teacher_label" ON "custom_pieces" USING btree ("teacher_id","normalized_label");--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD CONSTRAINT "lesson_sessions_custom_piece_id_custom_pieces_id_fk" FOREIGN KEY ("custom_piece_id") REFERENCES "public"."custom_pieces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_custom_piece_id_custom_pieces_id_fk" FOREIGN KEY ("custom_piece_id") REFERENCES "public"."custom_pieces"("id") ON DELETE set null ON UPDATE no action;