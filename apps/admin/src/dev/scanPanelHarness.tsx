// DEV-ONLY: its HTML entry is one `vite build` never names, so nothing here can reach a bundle.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import NotesActivitySheet from "../components/NotesActivitySheet";
import type { NotesActivity } from "../api";
import "../index.css";

const USER = "11111111-1111-1111-1111-111111111111";

const shapes: Record<string, NotesActivity["scoreScans"]> = {
  mixed: [
    { id: "s1", title: "Czerny Op. 599 No. 31", status: "ready", pageCount: 3, bytes: 246_000,
      createdAt: "2026-08-10T10:00:00.000Z", takenDownAt: null, hasBytes: true, referencedBy: 2 },
    { id: "s2", title: "Le Courant limpide", status: "created", pageCount: 1, bytes: null,
      createdAt: "2026-08-14T10:00:00.000Z", takenDownAt: null, hasBytes: false, referencedBy: 0 },
    { id: "s3", title: "Half-Time Show", status: "taken_down", pageCount: 5, bytes: 512_000,
      createdAt: "2026-07-02T10:00:00.000Z", takenDownAt: "2026-08-15T10:00:00.000Z",
      hasBytes: false, referencedBy: 0 },
  ],
  none: [],
  many: Array.from({ length: 8 }, (_, i) => ({
    id: `m${i}`, title: `Practical Method for Beginners, Op. 599 — No. ${30 + i}`,
    status: "ready", pageCount: (i % 4) + 1, bytes: 180_000 + i * 9_000,
    createdAt: "2026-08-01T10:00:00.000Z", takenDownAt: null, hasBytes: true, referencedBy: i % 3,
  })),
};

const shape = new URLSearchParams(location.search).get("shape") ?? "mixed";

const activity = {
  user: { id: USER, email: "teacher@example.com", displayName: "Ms. T", organization: null,
          isTeacher: true, isStudent: false, isAdmin: false, status: "active" },
  scoreScans: shapes[shape] ?? shapes.mixed,
  links: { asTeacher: [], asStudent: [] },
  invitesIssued: [],
  lessons: { count: 4, recordedAsTeacher: 4, recordedAsSelf: 0, recentPieceLabels: [] },
  notes: { sent: 3, sentAsTeacher: 3, selfNotes: 0, received: 0 },
  access: { status: "teacher_free" },
} as unknown as NotesActivity;

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
qc.setQueryData(["notes-activity", USER], activity);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <NotesActivitySheet userId={USER} onClose={() => {}} />
    </QueryClientProvider>
  </StrictMode>,
);
