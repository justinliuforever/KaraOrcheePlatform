-- The compat view carried the notes worker across the rename without it knowing. Its four statements
-- now name practice_items and the image that used the old name has no replicas left, which is the
-- condition this drop waits on — traffic weight is not it, a draining replica keeps its Service Bus
-- links and goes on consuming long after a revision is nominally replaced.
DROP VIEW "note_annotations";
