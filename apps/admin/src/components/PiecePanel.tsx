import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  api,
  type AdminBook,
  type AdminPieceDetail,
  type PieceEdit,
} from "../api";
import { Badge, ErrorNote, Spinner, rightsTone, statusTone } from "./ui";
import SlideOver from "./SlideOver";
import { timeAgo } from "../studio/gateInfo";

const inputCls =
  "w-full rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none focus:border-brand";
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

  const [form, setForm] = useState<EditForm | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"archive" | "takedown" | "restore" | null>(null);
  const [takedownNote, setTakedownNote] = useState("");

  useEffect(() => {
    if (detail.data) setForm(toForm(detail.data));
  }, [detail.data]);

  const dirty = useMemo(() => {
    if (!detail.data || !form) return false;
    return JSON.stringify(form) !== JSON.stringify(toForm(detail.data));
  }, [detail.data, form]);

  const applyEdit = useMutation<AdminPieceDetail, Error, PieceEdit>({
    mutationFn: (patch) =>
      api(`/admin/pieces/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      setConfirmApply(false);
      qc.invalidateQueries({ queryKey: ["piece", id] });
      qc.invalidateQueries({ queryKey: ["pieces"] });
    },
  });

  const lifecycle = useMutation<AdminPieceDetail, Error, { action: "archive" | "restore"; body?: Record<string, unknown> }>({
    mutationFn: ({ action, body }) =>
      api(`/admin/pieces/${id}/${action}`, { method: "POST", body: JSON.stringify(body ?? {}) }),
    onSuccess: () => {
      setConfirmAction(null);
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
    const bIdx = f.bookIndex ? Number(f.bookIndex) : null;
    if (bIdx !== d.bookIndex) patch.bookIndex = bIdx;
    if (f.rights !== d.rights) patch.rights = f.rights as PieceEdit["rights"];
    if (f.rightsNote !== (d.rightsNote ?? "")) patch.rightsNote = f.rightsNote || null;
    return patch;
  }

  return (
    <SlideOver
      onClose={onClose}
      onBeforeClose={() =>
        !dirty || window.confirm("You have unapplied edits — discard them?")
      }
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
            <Badge tone={rightsTone(d.rights)}>{d.rights.replace("_", " ")}</Badge>
            <Badge tone={statusTone(d.status)}>{d.status}</Badge>
            <Link
              className="text-xs text-ink-soft hover:text-ink px-1.5"
              to={`/pieces/${d.id}`}
              title="Open as a full page"
            >
              ⤢
            </Link>
            <button className="text-ink-faint hover:text-ink text-xl leading-none px-1" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>
      }
    >
      {/* ——— sticky-ish action row ——— */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
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
      {applyEdit.isError && <div className="mb-3"><ErrorNote message={applyEdit.error.message} /></div>}
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
              <select className={inputCls} value={form.bookId} onChange={(e) => setForm({ ...form, bookId: e.target.value })}>
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
            {d.workId && (
              <>
                {" "}Part of work <span className="font-mono">{d.workId}</span>
                {d.workIndex != null && ` (No. ${d.workIndex})`} — edit membership via a new
                version upload.
              </>
            )}
            {d.instrumentation && d.instrumentation.solo !== "piano" && (
              <> {" "}Instrument: <strong>{d.instrumentation.solo}</strong>.</>
            )}
          </p>
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
        {d.versions.map((v) => (
          <div key={v.version} className="rounded-lg border border-line mb-2">
            <div className="px-3 py-2 flex items-center justify-between bg-paper/50 border-b border-line">
              <span className="text-sm font-semibold">
                v{v.version}
                {v.version === d.publishedVersion && (
                  <span className="ml-2 align-middle"><Badge tone="ok">current</Badge></span>
                )}
              </span>
              <span className="text-[11px] text-ink-faint">
                {new Date(v.publishedAt).toLocaleString()}
                {v.engineSha && ` · ${v.engineSha}`}
              </span>
            </div>
            <table className="w-full">
              <tbody>
                {v.files.map((f, i) => (
                  <tr key={i} className="border-b border-line/50 last:border-0">
                    <td className="px-3 py-1.5 text-xs font-medium">{f.role}{f.variant ? ` · ${f.variant}` : ""}</td>
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
            <span className="text-[11px] text-ink-faint" title={new Date(j.updatedAt).toLocaleString()}>
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
              {new Date(e.createdAt).toLocaleString()}
              {e.detail && Object.keys(e.detail).length > 0 && ` · ${JSON.stringify(e.detail).slice(0, 120)}`}
            </p>
          </div>
        ))}
      </Section>
    </SlideOver>
  );
}
