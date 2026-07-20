import { useQuery } from "@tanstack/react-query";
import { getNotesActivity, type NotesAccess, type NotesActivity } from "../api";
import { ErrorNote, PanelSection, Spinner } from "./ui";
import StatusTag from "./StatusTag";
import ToneBadge from "./ToneBadge";
import SlideOver from "./SlideOver";

function accessLabel(a: NotesAccess): { tone: string; text: string; detail?: string } {
  switch (a.status) {
    case "teacher_free":
      return { tone: "brand", text: "Teacher — always free", detail: "Teachers bypass entitlements entirely." };
    case "beta_free":
      return { tone: "ok", text: "Beta — free for everyone", detail: "Monetization hasn't launched yet." };
    case "trial":
      return {
        tone: "warn",
        text: "On trial",
        detail: a.trialEndsAt ? `Trial ends ${new Date(a.trialEndsAt).toLocaleString()}` : undefined,
      };
    case "active":
      return { tone: "ok", text: "Active subscription" };
    case "grace":
      return { tone: "warn", text: "In billing grace period" };
    case "lapsed":
      return {
        tone: "bad",
        text: "Lapsed — new notes locked",
        detail: a.lockedAfter ? `Notes sent after ${new Date(a.lockedAfter).toLocaleString()} are locked` : undefined,
      };
    default:
      return { tone: "muted", text: a.status };
  }
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}

/** Read-only notes-activity aggregate for one account, opened from a pairing /
 * invite / entitlement row. No mutations — a diagnostic panel only. */
export default function NotesActivitySheet({ userId, onClose }: { userId: string; onClose: () => void }) {
  const q = useQuery<NotesActivity, Error>({
    queryKey: ["notes-activity", userId],
    queryFn: () => getNotesActivity(userId),
  });

  const d = q.data;
  const u = d?.user;

  return (
    <SlideOver
      width="min(52vw, 720px)"
      onClose={onClose}
      header={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{u?.email ?? "Notes activity"}</p>
            {u?.displayName && <p className="text-[11px] text-ink-faint truncate">{u.displayName}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {u?.isTeacher && <ToneBadge tone="ok">teacher</ToneBadge>}
            {u?.isStudent && <ToneBadge tone="muted">student</ToneBadge>}
            {u?.isAdmin && <ToneBadge tone="brand">admin</ToneBadge>}
            <button
              className="text-ink-faint hover:text-ink text-xl leading-none px-1 rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>
      }
    >
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNote message={q.error.message} />}

      {d && (
        <>
          <PanelSection title="Effective entitlement" defaultOpen>
            {(() => {
              const a = accessLabel(d.access);
              return (
                <div>
                  <ToneBadge tone={a.tone}>{a.text}</ToneBadge>
                  {a.detail && <p className="mt-1.5 text-xs text-ink-soft">{a.detail}</p>}
                </div>
              );
            })()}
          </PanelSection>

          <PanelSection
            title="Teacher–student links"
            defaultOpen
            badge={`${d.links.asTeacher.length} as teacher · ${d.links.asStudent.length} as student`}
          >
            {d.links.asTeacher.length === 0 && d.links.asStudent.length === 0 && (
              <p className="text-xs text-ink-faint">No links.</p>
            )}
            {d.links.asTeacher.map((l) => (
              <div key={l.id} className="flex items-center gap-2 py-1.5 border-b border-line/50 last:border-0">
                <span className="text-[11px] text-ink-faint w-16 shrink-0">teaches</span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  {l.studentEmail ?? l.studentId}
                  {l.studentName && <span className="text-ink-faint"> · {l.studentName}</span>}
                </span>
                <StatusTag value={l.status === "active" ? "published" : "archived"} family="lifecycle" label={l.status} />
              </div>
            ))}
            {d.links.asStudent.map((l) => (
              <div key={l.id} className="flex items-center gap-2 py-1.5 border-b border-line/50 last:border-0">
                <span className="text-[11px] text-ink-faint w-16 shrink-0">learns from</span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  {l.teacherEmail ?? l.teacherId}
                  {l.teacherName && <span className="text-ink-faint"> · {l.teacherName}</span>}
                </span>
                <StatusTag value={l.status === "active" ? "published" : "archived"} family="lifecycle" label={l.status} />
              </div>
            ))}
          </PanelSection>

          <PanelSection title="Invites issued" badge={`${d.invitesIssued.length}`}>
            {d.invitesIssued.length === 0 && <p className="text-xs text-ink-faint">No invites issued.</p>}
            {d.invitesIssued.map((inv) => (
              <div key={inv.id} className="flex items-center gap-2 py-1.5 border-b border-line/50 last:border-0">
                <span className="font-mono text-xs shrink-0">{inv.code}</span>
                <span className="text-[11px] text-ink-faint tabular-nums">
                  {inv.usedCount}/{inv.maxUses} used · expires {fmtDate(inv.expiresAt)}
                </span>
                <span className="ml-auto shrink-0">
                  <ToneBadge tone={inv.state === "active" ? "ok" : inv.state === "revoked" ? "bad" : "muted"}>
                    {inv.state}
                  </ToneBadge>
                </span>
              </div>
            ))}
          </PanelSection>

          <PanelSection title="Lessons taught" badge={`${d.lessons.count}`}>
            {d.lessons.recentPieceLabels.length === 0 ? (
              <p className="text-xs text-ink-faint">No lessons recorded.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {d.lessons.recentPieceLabels.map((p) => (
                  <span key={p} className="rounded-full bg-paper px-2 py-0.5 text-xs text-ink-soft">
                    {p}
                  </span>
                ))}
              </div>
            )}
          </PanelSection>

          <PanelSection title="Notes" defaultOpen badge={`${d.notes.sent} sent · ${d.notes.received} received`}>
            <div className="flex gap-8">
              <div>
                <p className="text-[11px] text-ink-faint">sent as teacher</p>
                <p className="text-lg font-semibold tabular-nums">{d.notes.sent}</p>
              </div>
              <div>
                <p className="text-[11px] text-ink-faint">received as student</p>
                <p className="text-lg font-semibold tabular-nums">{d.notes.received}</p>
              </div>
            </div>
          </PanelSection>
        </>
      )}
    </SlideOver>
  );
}
