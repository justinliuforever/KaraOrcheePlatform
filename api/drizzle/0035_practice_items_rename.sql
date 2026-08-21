-- The table holds practice items now, not only transcript annotations. The old name survives as a
-- view because the notes worker still writes it by hand in raw SQL, and a draining replica keeps
-- consuming for minutes after a new revision reports healthy — an old image selecting a name that no
-- longer exists 500s on every message it takes, silently, after ASR and the model are already paid for.
ALTER TABLE "note_annotations" RENAME TO "practice_items";--> statement-breakpoint

ALTER INDEX "ix_note_annotations_note" RENAME TO "ix_practice_items_note";--> statement-breakpoint
ALTER INDEX "ix_note_annotations_piece" RENAME TO "ix_practice_items_piece";--> statement-breakpoint

-- No ALTER VIEW ... SET DEFAULT here. An automatically updatable view inherits the base table's
-- defaults — measured, by deleting them and watching the worker's own INSERT still succeed — and a
-- default restated on the view is a second copy that can drift from the one it was copied from.
CREATE VIEW "note_annotations" AS SELECT * FROM "practice_items";
