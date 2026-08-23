/// The text lives in content.practicePlan and ONLY there; this sidecar carries which piece each entry
/// belongs to, index-aligned. Beside the blob rather than inside it, because an installed binary
/// rewrites content wholesale and would silently strip anything riding within.

export class UnknownPlanSlot extends Error {}

function planLength(content: unknown): number {
  const plan = (content as { practicePlan?: unknown[] } | null)?.practicePlan;
  return Array.isArray(plan) ? plan.length : 0;
}

/// Read side is defensive, never trusting the stored array: an installed binary edits the plan
/// without touching the sidecar, so length drift and dead slot ids are ordinary states, not errors.
export function planItemsWire(
  note: { content: unknown; planPieceIds: unknown },
  liveSlotIds: ReadonlySet<string>,
): { idx: number; notePieceId: string | null }[] {
  const stored = Array.isArray(note.planPieceIds) ? (note.planPieceIds as unknown[]) : [];
  const out: { idx: number; notePieceId: string | null }[] = [];
  for (let i = 0; i < planLength(note.content); i++) {
    const raw = stored[i];
    out.push({ idx: i, notePieceId: typeof raw === "string" && liveSlotIds.has(raw) ? raw : null });
  }
  return out;
}

/// Write side refuses an unknown slot outright — a typo silently becoming General would file the
/// teacher's assignment somewhere they never chose.
export function normalizePlanPieceIds(
  body: unknown,
  content: unknown,
  liveSlotIds: ReadonlySet<string>,
): (string | null)[] {
  const items = Array.isArray(body) ? body : [];
  const dense: (string | null)[] = new Array(planLength(content)).fill(null);
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const { idx, notePieceId } = item as { idx?: unknown; notePieceId?: unknown };
    if (notePieceId === null || notePieceId === undefined) continue;
    // Validate before placing: an unknown slot must refuse even when its idx has no home,
    // or a typo silently becomes General exactly when the plan shrank underneath it.
    if (typeof notePieceId !== "string" || !liveSlotIds.has(notePieceId)) throw new UnknownPlanSlot();
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= dense.length) continue;
    dense[idx] = notePieceId;
  }
  return dense;
}
