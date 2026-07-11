import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  api,
  ApiError,
  type AdminBook,
  type AdminPieceDetail,
  type AdminWork,
  type PieceEdit,
} from "../api";
import { ErrorNote, Spinner, inputCls, rightsTone, statusTone } from "./ui";
import ToneBadge from "./ToneBadge";
import SlideOver from "./SlideOver";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui-kit/alert-dialog";
import { keyLabel, timeAgo } from "../studio/gateInfo";

// What each published bundle file is FOR — reviewers shouldn't need to know role slugs.
const ROLE_LABELS: Record<string, string> = {
  score_events: "Score events — the note timeline the app plays and follows",
  accompaniment_events: "Accompaniment events — play-along track (multi-part pieces)",
  geometry: "Cursor geometry — where the cursor sits on each note",
  svg: "Engraving",
  reference_audio: "Reference audio — replaces synthesized playback in the app",
};

const labelCls = "block text-xs font-medium text-ink-soft mb-1";

function fmtBytes(n?: number): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Section({
  title,
  defaultOpen = false,
  badge,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="rounded-xl border border-line bg-card mb-3 overflow-hidden" open={defaultOpen}>
      <summary className="px-4 py-3 cursor-pointer select-none flex items-center justify-between text-sm font-semibold">
        {title}
        {badge && <span className="text-xs text-ink-faint font-normal">{badge}</span>}
      </summary>
      <div className="px-4 pb-4 border-t border-line pt-3">{children}</div>
    </details>
  );
}

type EditForm = {
  title: string;
  composer: string;
  subtitle: string;
  difficulty: string;
  tracking: "validated" | "experimental";
  bookId: string;
  bookIndex: string;
  workId: string;
  workIndex: string;
  rights: string;
  rightsNote: string;
};

function toForm(d: AdminPieceDetail): EditForm {
  return {
    title: d.title,
    composer: d.composer,
    subtitle: d.subtitle ?? "",
    difficulty: d.difficulty != null ? String(d.difficulty) : "",
    tracking: (d.tracking as "validated" | "experimental") ?? "experimental",
    bookId: d.bookId ?? "",
    bookIndex: d.bookIndex != null ? String(d.bookIndex) : "",
    workId: d.workId ?? "",
    workIndex: d.workIndex != null ? String(d.workIndex) : "",
    rights: d.rights,
    rightsNote: d.rightsNote ?? "",
  };
}

export default function PiecePanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const detail = useQuery<AdminPieceDetail, Error>({
    queryKey: ["piece", id],
    queryFn: () => api(`/admin/pieces/${id}`),
  });
  const booksQ = useQuery<{ items: AdminBook[] }, Error>({
    queryKey: ["books"],
    queryFn: () => api("/admin/books"),
  });
  const worksQ = useQuery<{ items: AdminWork[] }, Error>({
    queryKey: ["works"],
    queryFn: () => api("/admin/works"),
  });

  const [form, setForm] = useState<EditForm | null>(null);
  // Which snapshot the form was seeded from. Background refetches produce NEW data
  // objects (signed URLs change every response) — reseeding on every one would wipe
  // in-progress edits, so we only seed per piece id / after an explicit reset.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"archive" | "takedown" | "restore" | null>(null);
  const [takedownNote, setTakedownNote] = useState("");
  const [movementClash, setMovementClash] = useState<string | null>(null);
  // Discard-edits confirmation, replacing window.confirm. Drives an AlertDialog that
  // serves both the close guard ({kind:"close"}) and the sibling-navigation guard
  // ({kind:"nav"}). Same wording, same veto semantics as the old confirm().
  const [discard, setDiscard] = useState<{ kind: "close" } | { kind: "nav"; to: string } | null>(null);

  useEffect(() => {
    if (detail.data && seededFor !== detail.data.id) {
      setForm(toForm(detail.data));
      setSeededFor(detail.data.id);
    }
  }, [detail.data, seededFor]);

  const dirty = useMemo(() => {
    if (!detail.data || !form) return false;
    return JSON.stringify(form) !== JSON.stringify(toForm(detail.data));
  }, [detail.data, form]);

  const applyEdit = useMutation<AdminPieceDetail, Error, PieceEdit>({
    mutationFn: (patch) =>
      api(`/admin/pieces/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      setConfirmApply(false);
      setMovementClash(null);
      setSeededFor(null); // reseed from the fresh row (picks up new expectedUpdatedAt)
      qc.invalidateQueries({ queryKey: ["piece", id] });
      qc.invalidateQueries({ queryKey: ["pieces"] });
      qc.invalidateQueries({ queryKey: ["works"] });
    },
    onError: (e) => {
      setConfirmApply(false);
      setMovementClash(e instanceof ApiError && e.code === "movement_taken" ? e.message : null);
    },
  });

  const lifecycle = useMutation<AdminPieceDetail, Error, { action: "archive" | "restore"; body?: Record<string, unknown> }>({
    mutationFn: ({ action, body }) =>
      api(`/admin/pieces/${id}/${action}`, { method: "POST", body: JSON.stringify(body ?? {}) }),
    onSuccess: () => {
      setConfirmAction(null);
      setSeededFor(null);
      qc.invalidateQueries({ queryKey: ["piece", id] });
      qc.invalidateQueries({ queryKey: ["pieces"] });
    },
  });

  if (detail.isPending) {
    return (
      <SlideOver onClose={onClose} header={<p className="text-sm font-semibold">Loading…</p>}>
        <Spinner />
      </SlideOver>
    );
  }
  if (detail.isError) {
    return (
      <SlideOver onClose={onClose} header={<p className="text-sm font-semibold">Piece</p>}>
        <ErrorNote message={detail.error.message} />
      </SlideOver>
    );
  }
  const d = detail.data;
  const published = d.status === "published";
  const currentVersion = d.versions.find((v) => v.version === d.publishedVersion);
  const engravings = (currentVersion?.files ?? []).filter((f) => f.role === "svg" && f.url);
  const referenceAudio = (currentVersion?.files ?? []).find((f) => f.role === "reference_audio" && f.url);
  const facts = d.facts;
  const soloPartName = facts?.solo_part
    ? facts.parts?.find((p) => p.id === facts.solo_part)?.name ?? facts.solo_part
    : null;
  // The whole composition, this piece included, ordered by movement number.
  const family = d.work
    ? [
        ...d.workSiblings.map((s) => ({ ...s, self: false })),
        {
          id: d.id,
          title: d.title,
          subtitle: d.subtitle,
          workIndex: d.workIndex,
          status: d.status,
          publishedVersion: d.publishedVersion,
          instrumentation: d.instrumentation,
          self: true,
        },
      ].sort((a, b) => (a.workIndex ?? 999) - (b.workIndex ?? 999) || a.id.localeCompare(b.id))
    : [];

  function buildPatch(): PieceEdit {
    const f = form!;
    const patch: PieceEdit = { expectedUpdatedAt: d.updatedAt };
    if (f.title !== d.title) patch.title = f.title;
    if (f.composer !== d.composer) patch.composer = f.composer;
    if (f.subtitle !== (d.subtitle ?? "")) patch.subtitle = f.subtitle;
    const diff = f.difficulty ? Number(f.difficulty) : null;
    if (diff !== d.difficulty) patch.difficulty = diff;
    if (f.tracking !== d.tracking) patch.tracking = f.tracking;
    const bId = f.bookId || null;
    if (bId !== d.bookId) patch.bookId = bId;
    const bIdx = bId && f.bookIndex !== "" ? Number(f.bookIndex) : null;
    if (bIdx !== d.bookIndex) patch.bookIndex = bIdx;
    const wId = f.workId || null;
    if (wId !== d.workId) patch.workId = wId;
    const wIdx = wId && f.workIndex !== "" ? Number(f.workIndex) : null;
    if (wIdx !== d.workIndex) patch.workIndex = wIdx;
    if (f.rights !== d.rights) patch.rights = f.rights as PieceEdit["rights"];
    if (f.rightsNote !== (d.rightsNote ?? "")) patch.rightsNote = f.rightsNote || null;
    return patch;
  }

  return (
    <SlideOver
      onClose={onClose}
      onBeforeClose={() => {
        if (!dirty) return true;
        setDiscard({ kind: "close" });
        return false;
      }}
      header={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">
              {d.title}
              {d.subtitle && <span className="text-ink-soft font-normal"> · {d.subtitle}</span>}
            </p>
            <p className="text-[11px] text-ink-faint font-mono truncate">
              {d.composer} · {d.id}
              {d.publishedVersion != null && ` · v${d.publishedVersion}`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ToneBadge tone={(d.instrumentation?.solo ?? "piano") === "piano" ? "muted" : "ok"}>
              {d.instrumentation?.solo ?? "piano"}
            </ToneBadge>
            <ToneBadge tone={rightsTone(d.rights)}>{d.rights.replace("_", " ")}</ToneBadge>
            <ToneBadge tone={statusTone(d.status)}>{d.status}</ToneBadge>
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
      <div className="sticky top-[57px] z-10 bg-paper -mx-6 px-6 py-2.5 border-b border-line/60 flex items-center gap-2 mb-4 flex-wrap">
        <button
          className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 hover:opacity-90 disabled:opacity-40"
          disabled={!dirty || applyEdit.isPending}
          onClick={() => setConfirmApply(true)}
        >
          Apply changes
        </button>
        <button
          className="rounded-lg border border-line text-sm font-medium px-3.5 py-2 hover:bg-paper"
          onClick={() => nav(`/studio/new?piece=${d.id}`)}
          title="New score files through the full verification pipeline; publishes the next version"
        >
          Upload new version
        </button>
        <span className="flex-1" />
        {published ? (
          <>
            <button
              className="rounded-lg border border-red-200 text-bad text-sm font-medium px-3.5 py-2 hover:bg-red-50"
              onClick={() => setConfirmAction("takedown")}
            >
              Take down
            </button>
            <button
              className="rounded-lg border border-line text-sm font-medium px-3.5 py-2 hover:bg-paper"
              onClick={() => setConfirmAction("archive")}
            >
              Archive
            </button>
          </>
        ) : (
          d.publishedVersion != null && (
            <button
              className="rounded-lg border border-line text-sm font-medium px-3.5 py-2 hover:bg-paper disabled:opacity-40"
              disabled={d.rights !== "public_domain" && d.rights !== "licensed"}
              title={d.rights !== "public_domain" && d.rights !== "licensed" ? "Resolve rights before restoring" : undefined}
              onClick={() => setConfirmAction("restore")}
            >
              Restore to catalog
            </button>
          )
        )}
      </div>

      {confirmApply && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 mb-4 flex items-center justify-between gap-3">
          <p className="text-sm">
            {published
              ? "This updates the LIVE app catalog immediately."
              : "This updates the registry (piece is not live)."}
          </p>
          <div className="flex gap-2 shrink-0">
            <button className="text-sm text-ink-soft" onClick={() => setConfirmApply(false)}>
              Cancel
            </button>
            <button
              className="rounded-lg bg-brand text-white text-sm font-medium px-3.5 py-1.5"
              disabled={applyEdit.isPending}
              onClick={() => applyEdit.mutate(buildPatch())}
            >
              {applyEdit.isPending ? "Applying…" : "Confirm"}
            </button>
          </div>
        </div>
      )}
      {confirmAction && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 mb-4">
          <p className="text-sm mb-2">
            {confirmAction === "archive" && "Remove this piece from the app catalog now? (Reversible — Restore brings it back.)"}
            {confirmAction === "takedown" && "Take down: removes from the app now, marks rights as blocked, and records the reason."}
            {confirmAction === "restore" && "Put this piece back into the live app catalog?"}
          </p>
          {confirmAction === "takedown" && (
            <input
              className={`${inputCls} mb-2`}
              placeholder="Reason (e.g. rights claim received from …)"
              value={takedownNote}
              onChange={(e) => setTakedownNote(e.target.value)}
            />
          )}
          <div className="flex gap-2 justify-end">
            <button className="text-sm text-ink-soft" onClick={() => setConfirmAction(null)}>
              Cancel
            </button>
            <button
              className={`rounded-lg text-white text-sm font-medium px-3.5 py-1.5 ${confirmAction === "restore" ? "bg-brand" : "bg-bad"}`}
              disabled={lifecycle.isPending || (confirmAction === "takedown" && !takedownNote.trim())}
              onClick={() =>
                lifecycle.mutate(
                  confirmAction === "restore"
                    ? { action: "restore" }
                    : confirmAction === "takedown"
                      ? { action: "archive", body: { rights: "blocked", rightsNote: takedownNote } }
                      : { action: "archive" },
                )
              }
            >
              {lifecycle.isPending ? "Working…" : "Confirm"}
            </button>
          </div>
        </div>
      )}
      {movementClash && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 mb-4">
          <p className="text-sm mb-2">{movementClash}</p>
          <div className="flex gap-2 justify-end">
            <button className="text-sm text-ink-soft" onClick={() => setMovementClash(null)}>
              Cancel
            </button>
            <button
              className="rounded-lg bg-warn text-white text-sm font-medium px-3.5 py-1.5"
              disabled={applyEdit.isPending}
              onClick={() => applyEdit.mutate({ ...buildPatch(), confirmMovementClash: true })}
            >
              {applyEdit.isPending ? "Applying…" : "Apply anyway"}
            </button>
          </div>
        </div>
      )}
      {applyEdit.isError && !movementClash && (
        <div className="mb-3">
          <ErrorNote message={applyEdit.error.message} />
          {applyEdit.error instanceof ApiError && applyEdit.error.code === "stale_edit" && (
            <button
              className="mt-2 rounded-lg border border-line text-sm font-medium px-3.5 py-1.5 hover:bg-paper"
              onClick={() => {
                setSeededFor(null);
                qc.invalidateQueries({ queryKey: ["piece", id] });
              }}
            >
              Load the latest values (discards your unapplied edits)
            </button>
          )}
        </div>
      )}
      {lifecycle.isError && <div className="mb-3"><ErrorNote message={lifecycle.error.message} /></div>}

      {/* ——— editable metadata ——— */}
      {form && (
        <Section title="Catalog details" defaultOpen>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>Title</label>
              <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Composer</label>
              <input className={inputCls} value={form.composer} onChange={(e) => setForm({ ...form, composer: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Subtitle</label>
              <input className={inputCls} value={form.subtitle} onChange={(e) => setForm({ ...form, subtitle: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Difficulty</label>
              <select className={inputCls} value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: e.target.value })}>
                <option value="">unrated</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Shelf</label>
              <select
                className={inputCls}
                value={form.tracking}
                onChange={(e) => setForm({ ...form, tracking: e.target.value as EditForm["tracking"] })}
              >
                <option value="experimental">Challenge (experimental)</option>
                <option value="validated">Pieces (validated)</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Book</label>
              <select
                className={inputCls}
                value={form.bookId}
                onChange={(e) =>
                  setForm({ ...form, bookId: e.target.value, ...(e.target.value ? {} : { bookIndex: "" }) })
                }
              >
                <option value="">none</option>
                {booksQ.data?.items.map((b) => (
                  <option key={b.id} value={b.id}>{b.title}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Number in book</label>
              <input
                className={inputCls}
                type="number"
                value={form.bookIndex}
                disabled={!form.bookId}
                onChange={(e) => setForm({ ...form, bookIndex: e.target.value })}
              />
            </div>
          </div>
          <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
            The piece ID <span className="font-mono">{d.id}</span> is permanent — renaming changes what
            players see, not the ID. "Upload new version" always stays attached to this ID.
          </p>
        </Section>
      )}

      {form && (
        <Section
          title="Work membership"
          defaultOpen
          badge={
            d.work
              ? `${d.work.catalogue ?? d.work.title}${d.workIndex != null ? ` · No.${d.workIndex}` : ""}`
              : "standalone"
          }
        >
          {d.work && (
            <div className="rounded-lg border border-line bg-paper/50 px-3 py-2 mb-3">
              <p className="text-sm font-medium">
                {d.work.title}
                {d.work.catalogue && <span className="text-ink-soft font-normal"> · {d.work.catalogue}</span>}
              </p>
              <p className="text-[11px] text-ink-faint">
                {d.work.composer} · {d.work.workType.replaceAll("_", " ")} ·{" "}
                <span className="font-mono">{d.work.id}</span>
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Work (composition)</label>
              <select
                className={inputCls}
                value={form.workId}
                onChange={(e) =>
                  setForm({ ...form, workId: e.target.value, ...(e.target.value ? {} : { workIndex: "" }) })
                }
              >
                <option value="">standalone — not part of a work</option>
                {worksQ.data?.items.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.composer} · {w.title}
                    {w.catalogue ? ` (${w.catalogue})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Movement / No. in work</label>
              <input
                className={inputCls}
                type="number"
                value={form.workIndex}
                disabled={!form.workId}
                onChange={(e) => setForm({ ...form, workIndex: e.target.value })}
              />
            </div>
          </div>
          <p className="text-[11px] text-ink-faint mt-2 leading-relaxed">
            Membership is <strong>catalog metadata</strong>, edited here in place — the score
            content is untouched, so no re-upload is needed (content changes are what go
            through "Upload new version"). Applying updates the live app catalog immediately
            when the piece is published. Same movement number + same instrument as another
            piece is treated as a likely duplicate and asks for confirmation; different
            instruments sharing a number is normal (arrangements of the same movement).
            New works themselves are created during upload in the Studio wizard.
          </p>
          {family.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-1.5">
                In this work ({family.length} piece{family.length === 1 ? "" : "s"})
              </p>
              {family.map((s) => (
                <div
                  key={s.id}
                  className={`flex items-center gap-2 py-1.5 border-b border-line/50 last:border-0 ${s.self ? "bg-brand-soft/40 -mx-2 px-2 rounded" : ""}`}
                >
                  <span className="text-xs tabular-nums text-ink-faint w-10 shrink-0">
                    {s.workIndex != null ? `No.${s.workIndex}` : "—"}
                  </span>
                  <div className="min-w-0 flex-1">
                    {s.self ? (
                      <p className="text-xs font-medium truncate">
                        {s.title}
                        {s.subtitle && <span className="text-ink-soft font-normal"> · {s.subtitle}</span>}
                        <span className="text-brand"> (this piece)</span>
                      </p>
                    ) : (
                      <button
                        className="text-xs font-medium text-brand hover:underline truncate block text-left w-full"
                        onClick={() => {
                          if (dirty) {
                            setDiscard({ kind: "nav", to: s.id });
                            return;
                          }
                          nav(`/pieces?sel=${s.id}`);
                        }}
                      >
                        {s.title}
                        {s.subtitle && <span className="text-ink-soft font-normal"> · {s.subtitle}</span>}
                      </button>
                    )}
                  </div>
                  {(s.instrumentation?.solo ?? "piano") !== "piano" && (
                    <span className="text-[11px] text-ok shrink-0">{s.instrumentation!.solo}</span>
                  )}
                  <span className="shrink-0">
                    <ToneBadge tone={statusTone(s.status)}>{s.status}</ToneBadge>
                  </span>
                  {s.publishedVersion != null && (
                    <span className="text-[11px] text-ink-faint tabular-nums shrink-0">v{s.publishedVersion}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {form && (
        <Section title="Rights" defaultOpen badge={d.rights.replace("_", " ")}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Status</label>
              <select
                className={inputCls}
                value={form.rights}
                onChange={(e) => setForm({ ...form, rights: e.target.value })}
              >
                <option value="public_domain">public domain</option>
                <option value="licensed">licensed</option>
                <option value="unknown" disabled={published}>unknown{published ? " (archive first)" : ""}</option>
                <option value="blocked" disabled={published}>blocked{published ? " (use Take down)" : ""}</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Provenance / rights note</label>
              <textarea
                className={`${inputCls} h-16 resize-none`}
                value={form.rightsNote}
                onChange={(e) => setForm({ ...form, rightsNote: e.target.value })}
              />
            </div>
          </div>
        </Section>
      )}

      <Section
        title="Score facts (from the file)"
        defaultOpen
        badge={facts ? `${facts.measures ?? "?"} measures` : "not extracted"}
      >
        {facts ? (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
              <div className="flex justify-between"><dt className="text-ink-faint">Key</dt><dd>{keyLabel(facts.key)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-faint">Time signature</dt><dd>{facts.time ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-faint">Measures</dt><dd className="tabular-nums">{facts.measures ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-faint">Staves</dt><dd className="tabular-nums">{facts.staves ?? "—"}</dd></div>
              <div className="flex justify-between col-span-2">
                <dt className="text-ink-faint">Tempo</dt>
                <dd>
                  {facts.tempo_bpm ? `♩=${facts.tempo_bpm}` : <span className="text-warn">not marked in the score — engraver default 120 used</span>}
                  {facts.tempo_text ? ` · "${facts.tempo_text}"` : ""}
                </dd>
              </div>
              <div className="flex justify-between col-span-2">
                <dt className="text-ink-faint">Parts in the file</dt>
                <dd className="text-right">
                  {(facts.parts ?? []).map((p, i) => (
                    <span key={p.id}>
                      {i > 0 && " + "}
                      {p.name ?? `Part ${i + 1}`}
                      {facts.solo_part === p.id && <strong className="text-brand"> (solo)</strong>}
                    </span>
                  ))}
                  {(facts.parts ?? []).length === 0 && "—"}
                </dd>
              </div>
              {(facts.n_parts ?? 1) > 1 && soloPartName && (
                <div className="flex justify-between col-span-2">
                  <dt className="text-ink-faint">Students see &amp; follow</dt>
                  <dd>
                    <strong>{soloPartName}</strong> — the other part plays as accompaniment
                  </dd>
                </div>
              )}
              <div className="flex justify-between col-span-2">
                <dt className="text-ink-faint">Playback instrumentation</dt>
                <dd>
                  solo = <strong>{d.instrumentation?.solo ?? "piano"}</strong>
                  {(d.instrumentation?.parts?.length ?? 0) > 1 && ` · parts: ${d.instrumentation!.parts.join(" + ")}`}
                </dd>
              </div>
            </dl>
            <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
              Extracted from the MusicXML at upload — the score file is the ground truth, so
              these are read-only here. If a fact is wrong, the file is wrong: fix it in the
              notation software and "Upload new version".
            </p>
          </>
        ) : (
          <p className="text-xs text-ink-faint leading-relaxed">
            No extracted facts — this piece was published before Studio v3 introduced fact
            extraction. They'll be filled in automatically the next time a version is
            uploaded through the Studio.
          </p>
        )}
      </Section>

      <Section title="Audio" badge={referenceAudio ? "reference recording" : "synthesized"}>
        <p className="text-xs font-medium mb-1">Preview render{d.previewAudio ? " (latest build)" : ""}</p>
        {d.previewAudio ? (
          <>
            <audio controls preload="none" src={d.previewAudio.url} className="w-full" />
            <p className="text-[11px] text-ink-faint mt-1 leading-relaxed">
              Rendered {timeAgo(d.previewAudio.renderedAt)} by build{" "}
              <Link className="text-brand font-mono" to={`/studio/${d.previewAudio.jobId}`}>
                {d.previewAudio.jobId.slice(0, 8)}
              </Link>{" "}
              with the same instrument sound the app uses. Review aid only — it is never
              shipped in the published bundle, because the app synthesizes playback on the
              device from the score events (that is what keeps cursor sync and variable
              tempo exact).
            </p>
          </>
        ) : (
          <p className="text-[11px] text-ink-faint leading-relaxed">
            No staged preview available — build staging is temporary. Running a new build
            through the Studio regenerates it.
          </p>
        )}
        <div className="mt-3 pt-3 border-t border-line/60">
          <p className="text-xs font-medium mb-1">
            Reference audio{d.publishedVersion != null ? ` (published v${d.publishedVersion})` : ""}
          </p>
          {referenceAudio?.url ? (
            <>
              <audio controls preload="none" src={referenceAudio.url} className="w-full" />
              <p className="text-[11px] text-ink-faint mt-1 leading-relaxed">
                This produced recording replaces synthesized playback in the app. It passed
                the automated tempo/onset verification at upload, so tap-to-seek and cursor
                sync stay exact.
              </p>
            </>
          ) : (
            <p className="text-[11px] text-ink-faint leading-relaxed">
              None — the app synthesizes playback from the score events (the standard path).
              If a produced recording should replace the synth for this piece, attach it via
              "Upload new version".
            </p>
          )}
        </div>
      </Section>

      <Section title="Engraving previews" badge={`${engravings.length} variants`}>
        {engravings.length === 0 && <p className="text-xs text-ink-faint">No published engraving.</p>}
        {engravings.map((f) => (
          <details key={f.variant} className="rounded-lg border border-line mb-2 overflow-hidden">
            <summary className="px-3 py-2 text-xs font-medium cursor-pointer bg-paper/50 flex justify-between">
              <span>{f.variant}</span>
              <a className="text-brand" href={f.url!} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                open full ↗
              </a>
            </summary>
            <div className="max-h-120 overflow-y-auto bg-white">
              <img src={f.url!} alt={f.variant} className="w-full" />
            </div>
          </details>
        ))}
      </Section>

      <Section title="Version history" badge={`${d.versions.length} version${d.versions.length === 1 ? "" : "s"}`}>
        <p className="text-[11px] text-ink-faint mb-2 leading-relaxed">
          Every published version is an immutable bundle — these exact files are what the
          app downloads. Preview audio is deliberately absent (review aid, see Audio above).
          Older versions are never deleted, so installed apps keep working.
        </p>
        {d.versions.map((v) => (
          <div key={v.version} className="rounded-lg border border-line mb-2">
            <div className="px-3 py-2 flex items-center justify-between bg-paper/50 border-b border-line">
              <span className="text-sm font-semibold">
                v{v.version}
                {v.version === d.publishedVersion && (
                  <span className="ml-2 align-middle"><ToneBadge tone="ok">current</ToneBadge></span>
                )}
              </span>
              <span className="text-[11px] text-ink-faint tabular-nums">
                {new Date(v.publishedAt).toLocaleString()}
                {v.engineSha && ` · ${v.engineSha}`}
              </span>
            </div>
            <table className="w-full">
              <tbody>
                {v.files.map((f, i) => (
                  <tr key={i} className="border-b border-line/50 last:border-0">
                    <td className="px-3 py-1.5 text-xs">
                      <span className="font-medium">{ROLE_LABELS[f.role] ?? f.role}</span>
                      {f.variant && <span className="text-ink-soft"> · {f.variant}</span>}
                      <span className="block text-[10px] font-mono text-ink-faint">{f.role}</span>
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-ink-faint font-mono">{f.sha256?.slice(0, 12)}</td>
                    <td className="px-3 py-1.5 text-xs text-ink-soft text-right tabular-nums">{fmtBytes(f.bytes)}</td>
                    <td className="px-3 py-1.5 text-right">
                      {f.url && (
                        <a className="text-xs text-brand font-medium" href={f.url} target="_blank" rel="noreferrer">
                          download
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </Section>

      <Section title="Original sources" badge={`${d.sources.length} file${d.sources.length === 1 ? "" : "s"}`}>
        {d.sources.length === 0 && <p className="text-xs text-ink-faint">No archived sources for this piece.</p>}
        {d.sources.map((s, i) => (
          <div key={i} className="flex items-center justify-between py-1.5 border-b border-line/50 last:border-0">
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">{s.originalName ?? s.path}</p>
              <p className="text-[11px] text-ink-faint">
                {s.kind ?? (s.path.endsWith(".mid") ? "midi" : "musicxml")} · {fmtBytes(s.bytes)} ·{" "}
                {s.origin === "studio_upload" ? "studio upload" : "pre-studio archive"}
              </p>
            </div>
            {s.url && (
              <a className="text-xs text-brand font-medium shrink-0 ml-3" href={s.url} target="_blank" rel="noreferrer">
                download
              </a>
            )}
          </div>
        ))}
      </Section>

      <Section title="Build history" badge={`${d.jobs.length} build${d.jobs.length === 1 ? "" : "s"}`}>
        {d.jobs.length === 0 && (
          <p className="text-xs text-ink-faint">No studio builds — this piece was published with the original launch tooling.</p>
        )}
        {d.jobs.map((j) => (
          <div key={j.id} className="flex items-center justify-between py-1.5 border-b border-line/50 last:border-0">
            <div>
              <Link className="text-xs text-brand font-medium hover:underline" to={`/studio/${j.id}`}>
                {j.id.slice(0, 8)}
              </Link>
              <span className="text-[11px] text-ink-faint ml-2">
                {j.status.replaceAll("_", " ")}
                {j.publishedVersion != null && ` → v${j.publishedVersion}`}
              </span>
            </div>
            <span className="text-[11px] text-ink-faint tabular-nums" title={new Date(j.updatedAt).toLocaleString()}>
              {timeAgo(j.updatedAt)}
            </span>
          </div>
        ))}
      </Section>

      <Section title="Activity" badge={`${d.recentAudit.length} events`}>
        {d.recentAudit.length === 0 && <p className="text-xs text-ink-faint">No admin actions recorded yet.</p>}
        {d.recentAudit.map((e) => (
          <div key={e.id} className="py-1.5 border-b border-line/50 last:border-0">
            <p className="text-xs font-medium">{e.action}</p>
            <p className="text-[11px] text-ink-faint">
              <span className="tabular-nums">{new Date(e.createdAt).toLocaleString()}</span>
              {e.detail && Object.keys(e.detail).length > 0 && ` · ${JSON.stringify(e.detail).slice(0, 120)}`}
            </p>
          </div>
        ))}
      </Section>

      <AlertDialog open={discard !== null} onOpenChange={(open) => { if (!open) setDiscard(null); }}>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>You have unapplied edits — discard them?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const d = discard;
                setDiscard(null);
                if (d?.kind === "close") onClose();
                else if (d?.kind === "nav") nav(`/pieces?sel=${d.to}`);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SlideOver>
  );
}
