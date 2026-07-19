import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  deleteBook,
  getBook,
  patchBook,
  putBookCover,
  putBookNumbering,
  type AdminBookDetail,
  type BookEdit,
} from "../api";
import { AuditTrail, ErrorNote, PanelSection, Spinner, inputCls } from "./ui";
import StatusTag from "./StatusTag";
import SlideOver from "./SlideOver";
import FilePick from "../studio/wizard/FilePick";
import { validateCoverFile } from "../lib/coverValidation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui-kit/alert-dialog";

const labelCls = "block text-xs font-medium text-ink-soft mb-1";

type EditForm = {
  title: string;
  author: string;
  publisher: string;
  edition: string;
  pieceCount: string;
  description: string;
  sortIndex: string;
  rights: string;
  rightsNote: string;
};

function toForm(d: AdminBookDetail): EditForm {
  return {
    title: d.title,
    author: d.author ?? "",
    publisher: d.publisher ?? "",
    edition: d.edition ?? "",
    pieceCount: d.pieceCount != null ? String(d.pieceCount) : "",
    description: d.description ?? "",
    sortIndex: d.sortIndex != null ? String(d.sortIndex) : "",
    rights: d.rights,
    rightsNote: d.rightsNote ?? "",
  };
}

export default function BookPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const detail = useQuery<AdminBookDetail, Error>({
    queryKey: ["book", id],
    queryFn: () => getBook(id),
  });

  const [form, setForm] = useState<EditForm | null>(null);
  // Which snapshot the form was seeded from. Background refetches produce NEW data
  // objects (signed URLs change every response) — reseeding on every one would wipe
  // in-progress edits, so we only seed per book id / after an explicit reset.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [coverErr, setCoverErr] = useState<string | null>(null);
  const [editNumbers, setEditNumbers] = useState(false);
  const [numberDraft, setNumberDraft] = useState<Record<string, string>>({});
  const [numberError, setNumberError] = useState<string | null>(null);
  const [discard, setDiscard] = useState<{ kind: "close" } | { kind: "nav"; to: string } | null>(null);

  useEffect(() => {
    if (detail.data && seededFor !== detail.data.id) {
      setForm(toForm(detail.data));
      setSeededFor(detail.data.id);
    }
  }, [detail.data, seededFor]);

  const formDirty = useMemo(() => {
    if (!detail.data || !form) return false;
    return JSON.stringify(form) !== JSON.stringify(toForm(detail.data));
  }, [detail.data, form]);

  const numbersDirty = useMemo(() => {
    if (!editNumbers || !detail.data) return false;
    return detail.data.pieces.some(
      (p) => (numberDraft[p.id] ?? "") !== (p.bookIndex != null ? String(p.bookIndex) : ""),
    );
  }, [editNumbers, detail.data, numberDraft]);

  const dirty = formDirty || numbersDirty;

  const applyEdit = useMutation<unknown, Error, BookEdit>({
    mutationFn: (patch) => patchBook(id, patch),
    onSuccess: () => {
      setConfirmApply(false);
      setSeededFor(null); // reseed from the fresh row
      qc.invalidateQueries({ queryKey: ["book", id] });
      qc.invalidateQueries({ queryKey: ["books"] });
      // Book title/author feed the pieces table's Book column.
      qc.invalidateQueries({ queryKey: ["pieces"] });
      toast.success("Book updated — the app bookshelf reflects it now");
    },
    onError: () => setConfirmApply(false),
  });

  const replaceCover = useMutation<unknown, Error, File>({
    mutationFn: (f) => putBookCover(id, f),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["book", id] });
      qc.invalidateQueries({ queryKey: ["books"] });
      toast.success("Cover updated");
    },
  });

  const renumber = useMutation<
    { ok: boolean; changed: number },
    Error,
    { entries: { pieceId: string; bookIndex: number | null }[]; changedIds: string[] }
  >({
    mutationFn: ({ entries }) => putBookNumbering(id, entries),
    onSuccess: (res, { changedIds }) => {
      setEditNumbers(false);
      setNumberError(null);
      qc.invalidateQueries({ queryKey: ["book", id] });
      qc.invalidateQueries({ queryKey: ["books"] });
      qc.invalidateQueries({ queryKey: ["pieces"] });
      for (const pid of changedIds) qc.invalidateQueries({ queryKey: ["piece", pid] });
      toast.success(res.changed === 0 ? "Numbers already up to date" : `Renumbered ${res.changed} piece${res.changed === 1 ? "" : "s"}`);
    },
    onError: (e) => setNumberError(e.message),
  });

  const remove = useMutation<unknown, Error>({
    mutationFn: () => deleteBook(id),
    onSuccess: () => {
      setConfirmDelete(false);
      qc.invalidateQueries({ queryKey: ["books"] });
      qc.removeQueries({ queryKey: ["book", id] });
      toast.success("Book deleted");
      onClose();
    },
    onError: () => setConfirmDelete(false),
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
      <SlideOver onClose={onClose} header={<p className="text-sm font-semibold">Book</p>}>
        <ErrorNote message={detail.error.message} />
      </SlideOver>
    );
  }
  const d = detail.data;

  function buildPatch(): BookEdit {
    const f = form!;
    const patch: BookEdit = {};
    if (f.title !== d.title) patch.title = f.title;
    if (f.author !== (d.author ?? "")) patch.author = f.author || null;
    if (f.publisher !== (d.publisher ?? "")) patch.publisher = f.publisher || null;
    if (f.edition !== (d.edition ?? "")) patch.edition = f.edition || null;
    const pCount = f.pieceCount !== "" ? Number(f.pieceCount) : null;
    if (pCount !== d.pieceCount) patch.pieceCount = pCount;
    if (f.description !== (d.description ?? "")) patch.description = f.description || null;
    const sIdx = f.sortIndex !== "" ? Number(f.sortIndex) : null;
    if (sIdx !== d.sortIndex) patch.sortIndex = sIdx;
    if (f.rights !== d.rights) patch.rights = f.rights as BookEdit["rights"];
    if (f.rightsNote !== (d.rightsNote ?? "")) patch.rightsNote = f.rightsNote || null;
    return patch;
  }

  function draftIndexOf(pieceId: string): number | null {
    const v = (numberDraft[pieceId] ?? "").trim();
    return v === "" ? null : Number(v);
  }

  function goToPiece(pieceId: string) {
    const to = `/pieces?sel=${pieceId}`;
    if (dirty) {
      setDiscard({ kind: "nav", to });
      return;
    }
    nav(to);
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
          <div className="flex items-center gap-3 min-w-0">
            {d.coverThumbUrl ? (
              <img src={d.coverThumbUrl} alt="" className="w-9 h-12 rounded object-cover border border-line shrink-0" />
            ) : (
              <div className="w-9 h-12 rounded bg-line grid place-items-center text-[10px] text-ink-faint shrink-0">
                no cover
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{d.title}</p>
              <p className="text-[11px] text-ink-faint font-mono truncate">
                {d.author ? `${d.author} · ` : ""}
                {d.id}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusTag value={d.rights} family="rights" />
            <button
              className="text-ink-faint hover:text-ink text-xl leading-none px-1 rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => {
                if (dirty) setDiscard({ kind: "close" });
                else onClose();
              }}
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
          disabled={!formDirty || applyEdit.isPending}
          onClick={() => setConfirmApply(true)}
        >
          Apply changes
        </button>
        <span className="flex-1" />
        <button
          className="rounded-lg border border-red-200 text-bad text-sm font-medium px-3.5 py-2 hover:bg-red-50 disabled:opacity-40"
          disabled={d.pieces.length > 0 || remove.isPending}
          title={d.pieces.length > 0 ? "Only an empty book can be deleted — detach its pieces first" : undefined}
          onClick={() => setConfirmDelete(true)}
        >
          Delete book
        </button>
      </div>

      {applyEdit.isError && <div className="mb-3"><ErrorNote message={applyEdit.error.message} /></div>}
      {remove.isError && <div className="mb-3"><ErrorNote message={remove.error.message} /></div>}

      <PanelSection title="Cover" defaultOpen badge={d.coverUrl ? undefined : "missing"}>
        <div className="flex gap-4 items-start">
          {d.coverUrl ? (
            <img src={d.coverUrl} alt={`${d.title} cover`} className="w-44 aspect-[3/4] rounded-lg object-cover border border-line shrink-0" />
          ) : (
            <div className="w-44 aspect-[3/4] rounded-lg border-2 border-dashed border-line grid place-items-center shrink-0">
              <span className="rounded-full bg-bad px-2 py-0.5 text-xs font-medium text-white">Cover missing</span>
            </div>
          )}
          <div className="flex-1 min-w-0 space-y-3">
            {!d.coverUrl && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed">
                This book was created implicitly during a publish, so it has no cover yet — the
                app's bookshelf has no empty-cover state. Add a cover here and complete the
                details below to finish it.
              </div>
            )}
            <FilePick
              label={d.coverUrl ? "Replace cover" : "Add cover"}
              accept="image/jpeg,image/png,image/webp"
              hint="Portrait 3:4, at least 900×1200 — make your own artwork, don't scan a publisher's cover"
              file={null}
              onFile={async (f) => {
                setCoverErr(null);
                if (!f) return;
                const err = await validateCoverFile(f);
                if (err) {
                  setCoverErr(err);
                  return;
                }
                replaceCover.mutate(f);
              }}
            />
            {replaceCover.isPending && <p className="text-xs text-ink-faint">Uploading cover…</p>}
            {coverErr && <p className="text-xs text-bad">{coverErr}</p>}
            {replaceCover.isError && <ErrorNote message={replaceCover.error.message} />}
          </div>
        </div>
      </PanelSection>

      {form && (
        <PanelSection title="Book details" defaultOpen>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>Title</label>
              <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Author</label>
              <input className={inputCls} value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Publisher</label>
              <input className={inputCls} value={form.publisher} onChange={(e) => setForm({ ...form, publisher: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Edition</label>
              <input className={inputCls} value={form.edition} onChange={(e) => setForm({ ...form, edition: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Pieces in book (printed total)</label>
              <input
                className={inputCls}
                type="number"
                min={1}
                placeholder="unknown"
                value={form.pieceCount}
                onChange={(e) => setForm({ ...form, pieceCount: e.target.value })}
              />
              <p className="text-[11px] text-ink-faint mt-1">
                The authored total per the printed edition (98 for Czerny 599) — the app's
                "No. n of M" denominator, independent of how many are uploaded.
              </p>
            </div>
            <div>
              <label className={labelCls}>Shelf order (lower = earlier)</label>
              <input
                className={inputCls}
                type="number"
                placeholder="unordered"
                value={form.sortIndex}
                onChange={(e) => setForm({ ...form, sortIndex: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls}>Rights</label>
              <select className={inputCls} value={form.rights} onChange={(e) => setForm({ ...form, rights: e.target.value })}>
                <option value="public_domain">public domain</option>
                <option value="licensed">licensed</option>
                <option value="unknown">unknown</option>
                <option value="blocked">blocked</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Description</label>
              <textarea
                className={`${inputCls} h-20 resize-none`}
                placeholder="Shown to students on the book's shelf page."
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
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
          <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
            The book ID <span className="font-mono">{d.id}</span> is permanent. Applying updates
            the app bookshelf immediately.
          </p>
        </PanelSection>
      )}

      <PanelSection
        title="Table of contents"
        defaultOpen
        badge={`${d.pieces.length} piece${d.pieces.length === 1 ? "" : "s"}`}
      >
        {d.pieces.length === 0 ? (
          <p className="text-xs text-ink-faint leading-relaxed">
            No pieces yet — attach one via the Book field in a piece's panel, or during upload in
            the Studio wizard.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] text-ink-faint">Ordered the way the app's bookshelf shows them — numbered first.</p>
              {!editNumbers && (
                <button
                  className="rounded-lg border border-line text-xs font-medium px-2.5 py-1.5 hover:bg-paper shrink-0"
                  onClick={() => {
                    setNumberDraft(
                      Object.fromEntries(d.pieces.map((p) => [p.id, p.bookIndex != null ? String(p.bookIndex) : ""])),
                    );
                    setNumberError(null);
                    setEditNumbers(true);
                  }}
                >
                  Edit numbers
                </button>
              )}
            </div>
            {d.pieces.map((p) => (
              <div key={p.id} className="flex items-center gap-2 py-1.5 border-b border-line/50 last:border-0">
                {editNumbers ? (
                  <input
                    type="number"
                    min={0}
                    className="w-16 shrink-0 rounded-md border border-line bg-card px-2 py-1 text-xs tabular-nums outline-none focus:border-brand"
                    placeholder="—"
                    value={numberDraft[p.id] ?? ""}
                    onChange={(e) => setNumberDraft({ ...numberDraft, [p.id]: e.target.value })}
                  />
                ) : (
                  <span className="text-xs tabular-nums text-ink-faint w-16 shrink-0">
                    {p.bookIndex != null ? `No.${p.bookIndex}` : "—"}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <button
                    className="text-xs font-medium text-brand hover:underline truncate block text-left w-full"
                    onClick={() => goToPiece(p.id)}
                  >
                    {p.title}
                    {p.subtitle && <span className="text-ink-soft font-normal"> · {p.subtitle}</span>}
                  </button>
                </div>
                <span className="shrink-0">
                  <StatusTag value={p.status} family="lifecycle" />
                </span>
                {p.publishedVersion != null && (
                  <span className="text-[11px] text-ink-faint tabular-nums shrink-0">v{p.publishedVersion}</span>
                )}
              </div>
            ))}
            {editNumbers && (
              <div className="mt-3">
                {numberError && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 mb-2 text-xs">{numberError}</div>
                )}
                <div className="flex gap-2 items-center">
                  <button
                    className="rounded-lg bg-brand text-white text-sm font-medium px-3.5 py-1.5 hover:opacity-90 disabled:opacity-40"
                    disabled={!numbersDirty || renumber.isPending}
                    onClick={() =>
                      renumber.mutate({
                        entries: d.pieces.map((p) => ({ pieceId: p.id, bookIndex: draftIndexOf(p.id) })),
                        changedIds: d.pieces.filter((p) => draftIndexOf(p.id) !== p.bookIndex).map((p) => p.id),
                      })
                    }
                  >
                    {renumber.isPending ? "Saving…" : "Save numbers"}
                  </button>
                  <button
                    className="text-sm text-ink-soft"
                    onClick={() => {
                      setEditNumbers(false);
                      setNumberError(null);
                    }}
                  >
                    Cancel
                  </button>
                  <span className="text-[11px] text-ink-faint">Blank = unnumbered (sorts last).</span>
                </div>
              </div>
            )}
          </>
        )}
      </PanelSection>

      <PanelSection title="Activity" badge={`${d.recentAudit.length} events`}>
        <AuditTrail events={d.recentAudit} />
      </PanelSection>

      <AlertDialog open={confirmApply} onOpenChange={(open) => { if (!open) setConfirmApply(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply these book changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The app's bookshelf updates immediately — this is what students see.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={applyEdit.isPending} onClick={() => applyEdit.mutate(buildPatch())}>
              {applyEdit.isPending ? "Applying…" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{d.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              The book and its cover are removed permanently. No pieces reference it, so nothing
              else changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discard !== null} onOpenChange={(open) => { if (!open) setDiscard(null); }}>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>You have unapplied edits — discard them?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const dsc = discard;
                setDiscard(null);
                if (dsc?.kind === "close") onClose();
                else if (dsc?.kind === "nav") nav(dsc.to);
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
