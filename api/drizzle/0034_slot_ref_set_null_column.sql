ALTER TABLE "note_annotations" DROP CONSTRAINT "note_annotations_note_id_note_piece_id_note_pieces_note_id_id_fk";
--> statement-breakpoint
ALTER TABLE "note_annotations" DROP CONSTRAINT "note_annotations_note_id_grounded_piece_id_note_pieces_note_id_id_fk";
--> statement-breakpoint
ALTER TABLE "note_annotations" ADD CONSTRAINT "note_annotations_note_id_note_piece_id_note_pieces_note_id_id_fk" FOREIGN KEY ("note_id","note_piece_id") REFERENCES "public"."note_pieces"("note_id","id") ON DELETE SET NULL ("note_piece_id");
--> statement-breakpoint
ALTER TABLE "note_annotations" ADD CONSTRAINT "note_annotations_note_id_grounded_piece_id_note_pieces_note_id_id_fk" FOREIGN KEY ("note_id","grounded_piece_id") REFERENCES "public"."note_pieces"("note_id","id") ON DELETE SET NULL ("grounded_piece_id");
