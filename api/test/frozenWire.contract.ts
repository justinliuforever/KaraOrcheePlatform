import { z } from "zod";

// Installed binaries decode these and there is no version negotiation: a key may be added, never removed, nulled or narrowed.

export const frozenLocation = z.object({
  type: z.string(),
  grounded: z.boolean(),
});

export const frozenAnnotation = z.object({
  id: z.string().min(1),
  noteId: z.string().min(1),
  idx: z.number().int(),
  category: z.string().min(1),
  instruction: z.string().min(1),
  location: frozenLocation,
});

export const frozenPracticePlanItem = z.object({
  focus: z.string(),
  steps: z.array(z.string()),
  target: z.string(),
});

export const frozenContent = z.object({
  lessonSummary: z.string(),
  practicePlan: z.array(frozenPracticePlanItem),
});

// noteJobId and lessonSessionId are nullable in the table and non-optional in Swift: a real null bricks the note, so the contract holds the app's requirement, not the column's.
const frozenNoteCore = z.object({
  id: z.string().min(1),
  noteJobId: z.string().min(1),
  lessonSessionId: z.string().min(1),
  teacherId: z.string().min(1),
  createdAt: z.string().min(1),
  status: z.enum(["draft", "sent", "retracted"]),
  content: frozenContent,
  pieceId: z.string().nullable(),
  pieceLabel: z.string().nullable(),
  pieceVersion: z.number().int().nullable(),
});

export const frozenTeacherNote = frozenNoteCore.extend({
  scoreScanId: z.string().nullable(),
});

// scoreScanId is deliberately absent: a student never learns the id, only these three derived facts.
export const frozenStudentNote = frozenNoteCore.extend({
  noteJobId: z.string(),
  lessonSessionId: z.string(),
  hasScorePhotos: z.boolean(),
  scorePageCount: z.number().int().nullable(),
  scoreGone: z.boolean(),
});

export const frozenRetractedStub = z.object({
  id: z.string().min(1),
  status: z.literal("retracted"),
});

// Drop a field here and scan deletion goes permanently unavailable in the app while every server test stays green.
export const frozenUsedByRow = z.object({
  noteId: z.string().min(1),
  status: z.string().min(1),
  origin: z.string().min(1),
  recipientDeleted: z.boolean(),
  createdAt: z.string().min(1),
});

export const frozenScanWire = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  pageCount: z.number().int(),
  status: z.string().min(1),
  createdAt: z.string().min(1),
});

export const frozenScanPage = z.object({
  page: z.number().int(),
  url: z.string().min(1),
});

export const frozenScanDetail = z.object({
  scan: frozenScanWire,
  pages: z.array(frozenScanPage),
  expiresAt: z.string().min(1),
  usedBy: z.array(frozenUsedByRow),
  heldByLesson: z.boolean(),
});

export function assertFrozen<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`frozen wire broken at ${where} — ${issues}`);
  }
  return parsed.data;
}
