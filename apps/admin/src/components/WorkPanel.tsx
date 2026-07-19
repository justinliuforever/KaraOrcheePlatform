import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ApiError,
  WORK_TYPES,
  deleteWork,
  getWork,
  mergeWork,
  patchWork,
  searchWorks,
  type AdminWork,
  type AdminWorkDetail,
  type WorkEdit,
} from "../api";
import { AuditTrail, ErrorNote, PanelSection, Spinner, inputCls } from "./ui";
import StatusTag from "./StatusTag";
import ToneBadge from "./ToneBadge";
import SlideOver from "./SlideOver";
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
  composer: string;
  catalogue: string;
  workType: string;
  movementCount: string;
  sortIndex: string;
};

function toForm(d: AdminWorkDetail): EditForm {
  return {
    title: d.title,
    composer: d.composer,
    catalogue: d.catalogue ?? "",
    workType: d.workType,
    movementCount: d.movementCount != null ? String(d.movementCount) : "",
    sortIndex: d.sortIndex != null ? String(d.sortIndex) : "",
  };
}

export default function WorkPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const detail = useQuery<AdminWorkDetail, Error>({
    queryKey: ["work", id],
    queryFn: () => getWork(id),
  });

  const [form, setForm] = useState<EditForm | null>(null);
  // Seed once per work id — background refetches must not wipe in-progress edits.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mergeSearch, setMergeSearch] = useState("");
  const [mergeQ, setMergeQ] = useState("");
  // Target survives the confirm dialog closing: a movement_taken 409 needs it for
  // the explicit "merge anyway" retry.
  const [mergeTarget, setMergeTarget] = useState<AdminWork | null>(null);
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [mergeClash, setMergeClash] = useState<string | null>(null);
  const [discard, setDiscard] = useState<{ kind: "close" } | { kind: "nav"; to: string } | null>(null);

  useEffect(() => {
    if (detail.data && seededFor !== detail.data.id) {
      setForm(toForm(detail.data));
      setSeededFor(detail.data.id);
    }
  }, [detail.data, seededFor]);

  useEffect(() => {
    const t = setTimeout(() => setMergeQ(mergeSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [mergeSearch]);

  const dirty = useMemo(() => {
    if (!detail.data || !form) return false;
    return JSON.stringify(form) !== JSON.stringify(toForm(detail.data));
  }, [detail.data, form]);

  const targetsQ = useQuery<{ items: AdminWork[] }, Error>({
    queryKey: ["works", mergeQ],
    queryFn: () => searchWorks(mergeQ),
    enabled: mergeQ.length > 0,
  });

  const applyEdit = useMutation<unknown, Error, WorkEdit>({
    mutationFn: (patch) => patchWork(id, patch),
    onSuccess: () => {
      setConfirmApply(false);
      setSeededFor(null); // reseed from the fresh row
      qc.invalidateQueries({ queryKey: ["work", id] });
      qc.invalidateQueries({ queryKey: ["works"] });
      // Work title/catalogue feed the pieces table's Work column.
      qc.invalidateQueries({ queryKey: ["pieces"] });
      toast.success("Work updated — the app catalog reflects it now");
    },
    onError: () => setConfirmApply(false),
  });

  const merge = useMutation<
    { ok: boolean; moved: number },
    Error,
    { targetWorkId: string; movedIds: string[]; confirm?: boolean }
  >({
    mutationFn: ({ targetWorkId, confirm }) => mergeWork(id, targetWorkId, confirm),
    onSuccess: (res, { targetWorkId, movedIds }) => {
      qc.invalidateQueries({ queryKey: ["works"] });
      qc.invalidateQueries({ queryKey: ["books"] });
      qc.invalidateQueries({ queryKey: ["pieces"] });
      qc.invalidateQueries({ queryKey: ["work", targetWorkId] });
      for (const pid of movedIds) qc.invalidateQueries({ queryKey: ["piece", pid] });
      qc.removeQueries({ queryKey: ["work", id] });
      toast.success(`Merged — ${res.moved} piece${res.moved === 1 ? "" : "s"} moved`);
      setMergeConfirmOpen(false);
      setMergeTarget(null);
      setMergeClash(null);
      onClose();
    },
    onError: (e) => {
      setMergeClash(e instanceof ApiError && e.code === "movement_taken" ? e.message : null);
    },
  });

  const remove = useMutation<unknown, Error>({
    mutationFn: () => deleteWork(id),
    onSuccess: () => {
      setConfirmDelete(false);
      qc.invalidateQueries({ queryKey: ["works"] });
      qc.removeQueries({ queryKey: ["work", id] });
      toast.success("Work deleted");
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
      <SlideOver onClose={onClose} header={<p className="text-sm font-semibold">Work</p>}>
        <ErrorNote message={detail.error.message} />
      </SlideOver>
    );
  }
  const d = detail.data;

  function buildPatch(): WorkEdit {
    const f = form!;
    const patch: WorkEdit = {};
    if (f.title !== d.title) patch.title = f.title;
    if (f.composer !== d.composer) patch.composer = f.composer;
    if (f.catalogue !== (d.catalogue ?? "")) patch.catalogue = f.catalogue || null;
    if (f.workType !== d.workType) patch.workType = f.workType as WorkEdit["workType"];
    const mCount = f.movementCount !== "" ? Number(f.movementCount) : null;
    if (mCount !== d.movementCount) patch.movementCount = mCount;
    const sIdx = f.sortIndex !== "" ? Number(f.sortIndex) : null;
    if (sIdx !== d.sortIndex) patch.sortIndex = sIdx;
    return patch;
  }

  function guardedNav(to: string) {
    if (dirty) {
      setDiscard({ kind: "nav", to });
      return;
    }
    nav(to);
  }

  const movedIds = d.pieces.map((p) => p.id);

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
              {d.catalogue && <span className="text-ink-soft font-normal"> · {d.catalogue}</span>}
            </p>
            <p className="text-[11px] text-ink-faint font-mono truncate">
              {d.composer} · {d.id}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ToneBadge tone="muted">{d.workType.replaceAll("_", " ")}</ToneBadge>
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
          disabled={!dirty || applyEdit.isPending}
          onClick={() => setConfirmApply(true)}
        >
          Apply changes
        </button>
        <span className="flex-1" />
        <button
          className="rounded-lg border border-red-200 text-bad text-sm font-medium px-3.5 py-2 hover:bg-red-50 disabled:opacity-40"
          disabled={d.pieces.length > 0 || remove.isPending}
          title={d.pieces.length > 0 ? "Only an empty work can be deleted — move or detach its pieces first" : undefined}
          onClick={() => setConfirmDelete(true)}
        >
          Delete work
        </button>
      </div>

      {applyEdit.isError && <div className="mb-3"><ErrorNote message={applyEdit.error.message} /></div>}
      {remove.isError && <div className="mb-3"><ErrorNote message={remove.error.message} /></div>}

      {form && (
        <PanelSection title="Work details" defaultOpen>
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
              <label className={labelCls}>Catalogue No. (Op. / K. / BWV)</label>
              <input
                className={inputCls}
                placeholder="none"
                value={form.catalogue}
                onChange={(e) => setForm({ ...form, catalogue: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls}>Type</label>
              <select className={inputCls} value={form.workType} onChange={(e) => setForm({ ...form, workType: e.target.value })}>
                {WORK_TYPES.map((t) => (
                  <option key={t} value={t}>{t.replaceAll("_", " ")}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Movements (authored total)</label>
              <input
                className={inputCls}
                type="number"
                min={1}
                placeholder="unknown"
                value={form.movementCount}
                onChange={(e) => setForm({ ...form, movementCount: e.target.value })}
              />
              <p className="text-[11px] text-ink-faint mt-1">
                Per the composition itself (25 for Op. 100) — the app's "No. n of M"
                denominator, independent of how many are uploaded.
              </p>
            </div>
            <div>
              <label className={labelCls}>Sort order within composer</label>
              <input
                className={inputCls}
                type="number"
                placeholder="unordered"
                value={form.sortIndex}
                onChange={(e) => setForm({ ...form, sortIndex: e.target.value })}
              />
            </div>
          </div>
          <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
            Works feed the app's collapse headers — applying updates the live catalog
            immediately. The work ID <span className="font-mono">{d.id}</span> is permanent.
          </p>
        </PanelSection>
      )}

      <PanelSection
        title="Movements"
        defaultOpen
        badge={`${d.pieces.length} piece${d.pieces.length === 1 ? "" : "s"}`}
      >
        {d.pieces.length === 0 && (
          <p className="text-xs text-ink-faint leading-relaxed">
            No pieces reference this work — it never reaches the app catalog while empty.
          </p>
        )}
        {d.pieces.map((p) => (
          <div key={p.id} className="flex items-center gap-2 py-1.5 border-b border-line/50 last:border-0">
            <span className="text-xs tabular-nums text-ink-faint w-10 shrink-0">
              {p.workIndex != null ? `No.${p.workIndex}` : "—"}
            </span>
            <div className="min-w-0 flex-1">
              <button
                className="text-xs font-medium text-brand hover:underline truncate block text-left w-full"
                onClick={() => guardedNav(`/pieces?sel=${p.id}`)}
              >
                {p.title}
                {p.subtitle && <span className="text-ink-soft font-normal"> · {p.subtitle}</span>}
              </button>
            </div>
            {(p.instrumentation?.solo ?? "piano") !== "piano" && (
              <span className="text-[11px] text-ok shrink-0">{p.instrumentation!.solo}</span>
            )}
            <span className="shrink-0">
              <StatusTag value={p.status} family="lifecycle" />
            </span>
            {p.publishedVersion != null && (
              <span className="text-[11px] text-ink-faint tabular-nums shrink-0">v{p.publishedVersion}</span>
            )}
          </div>
        ))}
      </PanelSection>

      {d.children.length > 0 && (
        <PanelSection title="Volumes" defaultOpen badge={`${d.children.length} nested`}>
          {d.children.map((c) => (
            <div key={c.id} className="flex items-center gap-2 py-1.5 border-b border-line/50 last:border-0">
              <div className="min-w-0 flex-1">
                <button
                  className="text-xs font-medium text-brand hover:underline truncate block text-left w-full"
                  onClick={() => guardedNav(`/collections?tab=works&sel=${c.id}`)}
                >
                  {c.title}
                  {c.catalogue && <span className="text-ink-soft font-normal"> · {c.catalogue}</span>}
                </button>
              </div>
              <span className="text-[11px] text-ink-faint">{c.workType.replaceAll("_", " ")}</span>
            </div>
          ))}
          <p className="text-[11px] text-ink-faint mt-2 leading-relaxed">
            A work with nested volumes can't be merged away — re-point each volume's parent
            first.
          </p>
        </PanelSection>
      )}

      <PanelSection title="Merge" badge="absorb a duplicate">
        <p className="text-[11px] text-ink-faint mb-2 leading-relaxed">
          Merge this work into the canonical one: every piece moves over with its movement
          number kept, then this work is deleted. One atomic operation — use it when an upload
          created a duplicate.
        </p>
        <label className={labelCls}>Merge into another work…</label>
        <input
          className={inputCls}
          placeholder="Search title / composer / catalogue no."
          value={mergeSearch}
          onChange={(e) => setMergeSearch(e.target.value)}
        />
        {mergeQ.length > 0 && (
          <div className="mt-2 rounded-lg border border-line divide-y divide-line max-h-44 overflow-y-auto">
            {(targetsQ.data?.items ?? []).filter((w) => w.id !== id).map((w) => (
              <button
                key={w.id}
                className="w-full text-left px-3 py-2 text-sm hover:bg-paper"
                onClick={() => {
                  setMergeClash(null);
                  setMergeTarget(w);
                  setMergeConfirmOpen(true);
                }}
              >
                <span className="font-medium">{w.title}</span>
                <span className="text-ink-faint text-xs">
                  {" "}· {w.composer}
                  {w.catalogue ? ` · ${w.catalogue}` : ""} · {w.pieceCount ?? 0} piece{(w.pieceCount ?? 0) === 1 ? "" : "s"}
                </span>
              </button>
            ))}
            {targetsQ.data && targetsQ.data.items.filter((w) => w.id !== id).length === 0 && (
              <p className="px-3 py-2 text-xs text-ink-faint">No other work matches.</p>
            )}
          </div>
        )}
        {mergeClash && mergeTarget && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 mt-3">
            <p className="text-sm mb-2">{mergeClash}</p>
            <div className="flex gap-2 justify-end">
              <button
                className="text-sm text-ink-soft"
                onClick={() => {
                  setMergeClash(null);
                  setMergeTarget(null);
                }}
              >
                Cancel
              </button>
              <button
                className="rounded-lg bg-warn text-white text-sm font-medium px-3.5 py-1.5"
                disabled={merge.isPending}
                onClick={() => merge.mutate({ targetWorkId: mergeTarget.id, movedIds, confirm: true })}
              >
                {merge.isPending ? "Merging…" : "Merge anyway"}
              </button>
            </div>
          </div>
        )}
        {merge.isError && !mergeClash && (
          <div className="mt-3"><ErrorNote message={merge.error.message} /></div>
        )}
      </PanelSection>

      <PanelSection title="Activity" badge={`${d.recentAudit.length} events`}>
        <AuditTrail events={d.recentAudit} />
      </PanelSection>

      <AlertDialog open={confirmApply} onOpenChange={(open) => { if (!open) setConfirmApply(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply these work changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Works feed the app's collapse headers — the live catalog updates immediately.
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

      <AlertDialog
        open={mergeConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setMergeConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge into "{mergeTarget?.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              All {d.pieces.length} piece{d.pieces.length === 1 ? "" : "s"} move to "{mergeTarget?.title}", and
              this work is deleted. Movement numbers are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setMergeTarget(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={merge.isPending}
              onClick={() => mergeTarget && merge.mutate({ targetWorkId: mergeTarget.id, movedIds })}
            >
              {merge.isPending ? "Merging…" : "Merge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{d.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              The work is removed permanently. No pieces reference it, so the app catalog is
              unaffected.
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
