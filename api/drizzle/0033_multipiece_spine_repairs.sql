ALTER TABLE "note_annotations" DROP CONSTRAINT "note_annotations_note_piece_id_note_pieces_id_fk";
--> statement-breakpoint
ALTER TABLE "note_annotations" DROP CONSTRAINT "note_annotations_grounded_piece_id_note_pieces_id_fk";
--> statement-breakpoint
ALTER TABLE "practice_subjects" DROP CONSTRAINT "practice_subjects_custom_piece_id_custom_pieces_id_fk";
--> statement-breakpoint
ALTER TABLE "note_pieces" ADD CONSTRAINT "uq_note_pieces_note_id" UNIQUE("note_id","id");
--> statement-breakpoint
ALTER TABLE "note_annotations" ADD CONSTRAINT "note_annotations_note_id_note_piece_id_note_pieces_note_id_id_fk" FOREIGN KEY ("note_id","note_piece_id") REFERENCES "public"."note_pieces"("note_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "note_annotations" ADD CONSTRAINT "note_annotations_note_id_grounded_piece_id_note_pieces_note_id_id_fk" FOREIGN KEY ("note_id","grounded_piece_id") REFERENCES "public"."note_pieces"("note_id","id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_subjects" ADD CONSTRAINT "practice_subjects_custom_piece_id_custom_pieces_id_fk" FOREIGN KEY ("custom_piece_id") REFERENCES "public"."custom_pieces"("id") ON DELETE cascade ON UPDATE no action;
