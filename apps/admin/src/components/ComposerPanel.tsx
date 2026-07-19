import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createComposer,
  deleteComposer,
  listComposers,
  patchComposer,
  putComposerPortrait,
  type AdminComposer,
  type ComposerEdit,
  type ComposersResponse,
} from "../api";
import { ErrorNote, PanelSection, Spinner, inputCls } from "./ui";
import SlideOver from "./SlideOver";
import FilePick from "../studio/wizard/FilePick";
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

/** Edit an existing registry entry (id) or create one, optionally pre-filled with
 * an unregistered composer string. */
export type ComposerTarget = { kind: "edit"; id: string } | { kind: "create"; name: string };

type EditForm = {
  name: string;
  sortName: string;
  aliases: string[];
  birthYear: string;
  deathYear: string;
  bio: string;
  attribution: string;
  sourceUrl: string;
};

function toForm(c: AdminComposer): EditForm {
  return {
    name: c.name,
    sortName: c.sortName ?? "",
    aliases: c.aliases,
    birthYear: c.birthYear != null ? String(c.birthYear) : "",
    deathYear: c.deathYear != null ? String(c.deathYear) : "",
    bio: c.bio ?? "",
    attribution: c.attribution ?? "",
    sourceUrl: c.sourceUrl ?? "",
  };
}

const emptyForm = (name: string): EditForm => ({
  name,
  sortName: "",
  aliases: [],
  birthYear: "",
  deathYear: "",
  bio: "",
  attribution: "",
  sourceUrl: "",
});

export default function ComposerPanel({
  target,
  onClose,
  onCreated,
}: {
  target: ComposerTarget;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const isCreate = target.kind === "create";
  // The registry list is the single source — no per-composer detail endpoint.
  const listQ = useQuery<ComposersResponse, Error>({
    queryKey: ["composers"],
    queryFn: listComposers,
  });
  const entry = !isCreate ? listQ.data?.items.find((c) => c.id === target.id) : undefined;
  const usedStrings =
    !isCreate && listQ.data
      ? listQ.data.strings.filter((s) => s.composerId === target.id)
      : [];

  const [form, setForm] = useState<EditForm | null>(isCreate ? emptyForm(target.name) : null);
  // Seed once per composer id — background refetches must not wipe in-progress edits.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [discard, setDiscard] = useState(false);

  useEffect(() => {
    if (entry && seededFor !== entry.id) {
      setForm(toForm(entry));
      setSeededFor(entry.id);
    }
  }, [entry, seededFor]);

  const dirty = useMemo(() => {
    if (!form) return false;
    if (isCreate) return JSON.stringify(form) !== JSON.stringify(emptyForm(target.name));
    if (!entry) return false;
    return JSON.stringify(form) !== JSON.stringify(toForm(entry));
  }, [form, entry, isCreate, target]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["composers"] });
  };

  const create = useMutation<AdminComposer, Error>({
    mutationFn: () => {
      const f = form!;
      return createComposer({
        name: f.name.trim(),
        ...(f.sortName.trim() ? { sortName: f.sortName.trim() } : {}),
        ...(f.aliases.length > 0 ? { aliases: f.aliases } : {}),
        ...(f.birthYear !== "" ? { birthYear: Number(f.birthYear) } : {}),
        ...(f.deathYear !== "" ? { deathYear: Number(f.deathYear) } : {}),
        ...(f.bio.trim() ? { bio: f.bio.trim() } : {}),
        ...(f.attribution.trim() ? { attribution: f.attribution.trim() } : {}),
        ...(f.sourceUrl.trim() ? { sourceUrl: f.sourceUrl.trim() } : {}),
      });
    },
    onSuccess: (c) => {
      invalidate();
      toast.success(`"${c.name}" registered`);
      if (onCreated) onCreated(c.id);
      else onClose();
    },
  });

  const applyEdit = useMutation<AdminComposer, Error, ComposerEdit>({
    mutationFn: (patch) => patchComposer(target.kind === "edit" ? target.id : "", patch),
    onSuccess: () => {
      setConfirmApply(false);
      setSeededFor(null); // reseed from the fresh row
      invalidate();
      toast.success("Composer updated — the app catalog reflects it now");
    },
    onError: () => setConfirmApply(false),
  });

  const uploadPortrait = useMutation<AdminComposer, Error, File>({
    mutationFn: (f) => putComposerPortrait(target.kind === "edit" ? target.id : "", f),
    onSuccess: () => {
      invalidate();
      toast.success("Portrait updated");
    },
  });

  const remove = useMutation<unknown, Error>({
    mutationFn: () => deleteComposer(target.kind === "edit" ? target.id : ""),
    onSuccess: () => {
      setConfirmDelete(false);
      invalidate();
      toast.success("Composer removed from the registry");
      onClose();
    },
    onError: () => setConfirmDelete(false),
  });

  function buildPatch(): ComposerEdit {
    const f = form!;
    const d = entry!;
    const patch: ComposerEdit = {};
    if (f.name.trim() !== d.name) patch.name = f.name.trim();
    if (f.sortName !== (d.sortName ?? "")) patch.sortName = f.sortName.trim() || null;
    if (JSON.stringify(f.aliases) !== JSON.stringify(d.aliases)) patch.aliases = f.aliases;
    const born = f.birthYear !== "" ? Number(f.birthYear) : null;
    if (born !== d.birthYear) patch.birthYear = born;
    const died = f.deathYear !== "" ? Number(f.deathYear) : null;
    if (died !== d.deathYear) patch.deathYear = died;
    if (f.bio !== (d.bio ?? "")) patch.bio = f.bio.trim() || null;
    if (f.attribution !== (d.attribution ?? "")) patch.attribution = f.attribution.trim() || null;
    if (f.sourceUrl !== (d.sourceUrl ?? "")) patch.sourceUrl = f.sourceUrl.trim() || null;
    return patch;
  }

  function addAlias() {
    const v = aliasDraft.trim();
    if (!v || !form) return;
    if (form.aliases.includes(v) || v === form.name.trim()) {
      setAliasDraft("");
      return;
    }
    setForm({ ...form, aliases: [...form.aliases, v] });
    setAliasDraft("");
  }

  if (!isCreate && (listQ.isPending || (!entry && !listQ.isError))) {
    return (
      <SlideOver onClose={onClose} header={<p className="text-sm font-semibold">Loading…</p>}>
        {listQ.isPending ? <Spinner /> : <ErrorNote message="Composer not found — it may have been deleted." />}
      </SlideOver>
    );
  }
  if (listQ.isError) {
    return (
      <SlideOver onClose={onClose} header={<p className="text-sm font-semibold">Composer</p>}>
        <ErrorNote message={listQ.error.message} />
      </SlideOver>
    );
  }

  const guardedClose = () => {
    if (dirty) setDiscard(true);
    else onClose();
  };

  return (
    <SlideOver
      onClose={onClose}
      onBeforeClose={() => {
        if (!dirty) return true;
        setDiscard(true);
        return false;
      }}
      header={
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {entry?.portraitUrl ? (
              <img src={entry.portraitUrl} alt="" className="size-10 rounded-full object-cover border border-line shrink-0" />
            ) : (
              <div className="size-10 rounded-full bg-line grid place-items-center text-[10px] text-ink-faint shrink-0">
                {isCreate ? "new" : "—"}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">
                {isCreate ? (form?.name.trim() ? form.name : "New composer") : entry!.name}
              </p>
              <p className="text-[11px] text-ink-faint font-mono truncate">
                {isCreate ? "not registered yet" : entry!.id}
              </p>
            </div>
          </div>
          <button
            className="text-ink-faint hover:text-ink text-xl leading-none px-1 rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={guardedClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      }
    >
      <div className="sticky top-[57px] z-10 bg-paper -mx-6 px-6 py-2.5 border-b border-line/60 flex items-center gap-2 mb-4 flex-wrap">
        {isCreate ? (
          <button
            className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 hover:opacity-90 disabled:opacity-40"
            disabled={!form?.name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Create composer"}
          </button>
        ) : (
          <>
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
              disabled={remove.isPending}
              title="Allowed even while in use — pieces keep their composer strings; the app falls back to a monogram"
              onClick={() => setConfirmDelete(true)}
            >
              {entry && entry.usageCount > 0
                ? `Delete entry (${entry.usageCount} in use)`
                : "Delete entry"}
            </button>
          </>
        )}
      </div>

      {create.isError && <div className="mb-3"><ErrorNote message={create.error.message} /></div>}
      {applyEdit.isError && <div className="mb-3"><ErrorNote message={applyEdit.error.message} /></div>}
      {remove.isError && <div className="mb-3"><ErrorNote message={remove.error.message} /></div>}

      <PanelSection title="Portrait" defaultOpen badge={entry?.portraitUrl ? undefined : "none"}>
        {isCreate ? (
          <p className="text-xs text-ink-faint leading-relaxed">
            Create the entry first — the portrait upload unlocks right after.
          </p>
        ) : (
          <div className="flex gap-4 items-start">
            {entry!.portraitUrl ? (
              <img
                src={entry!.portraitUrl}
                alt={`${entry!.name} portrait`}
                className="size-36 rounded-lg object-cover border border-line shrink-0"
              />
            ) : (
              <div className="size-36 rounded-lg border-2 border-dashed border-line grid place-items-center shrink-0 text-xs text-ink-faint">
                no portrait
              </div>
            )}
            <div className="flex-1 min-w-0 space-y-3">
              <FilePick
                label={entry!.portraitUrl ? "Replace portrait" : "Add portrait"}
                accept="image/jpeg,image/png,image/webp"
                hint="Any aspect, at least 256px on the short side — stored as a 512×512 square"
                file={null}
                onFile={(f) => {
                  if (f) uploadPortrait.mutate(f);
                }}
              />
              {uploadPortrait.isPending && <p className="text-xs text-ink-faint">Uploading portrait…</p>}
              {uploadPortrait.isError && <ErrorNote message={uploadPortrait.error.message} />}
            </div>
          </div>
        )}
      </PanelSection>

      {form && (
        <PanelSection title="Registry entry" defaultOpen>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>Canonical name (exactly as used on pieces)</label>
              <input
                className={inputCls}
                placeholder="Johann Friedrich Burgmüller"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Sort name</label>
              <input
                className={inputCls}
                placeholder="Burgmüller, Johann Friedrich"
                value={form.sortName}
                onChange={(e) => setForm({ ...form, sortName: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Aliases (alternate spellings that map here)</label>
              <div className="flex gap-2">
                <input
                  className={inputCls}
                  placeholder="J. F. Burgmüller"
                  value={aliasDraft}
                  onChange={(e) => setAliasDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addAlias();
                    }
                  }}
                />
                <button
                  className="rounded-lg border border-line text-sm font-medium px-3.5 hover:bg-paper shrink-0 disabled:opacity-40"
                  disabled={!aliasDraft.trim()}
                  onClick={addAlias}
                >
                  Add
                </button>
              </div>
              {form.aliases.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {form.aliases.map((a) => (
                    <span
                      key={a}
                      className="inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2.5 py-1 text-xs"
                    >
                      {a}
                      <button
                        className="text-ink-faint hover:text-bad leading-none"
                        aria-label={`Remove alias ${a}`}
                        onClick={() => setForm({ ...form, aliases: form.aliases.filter((x) => x !== a) })}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className={labelCls}>Born</label>
              <input
                className={inputCls}
                type="number"
                min={1000}
                max={9999}
                placeholder="1806"
                value={form.birthYear}
                onChange={(e) => setForm({ ...form, birthYear: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls}>Died</label>
              <input
                className={inputCls}
                type="number"
                min={1000}
                max={9999}
                placeholder="1874"
                value={form.deathYear}
                onChange={(e) => setForm({ ...form, deathYear: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Bio</label>
              <textarea
                className={`${inputCls} h-20 resize-none`}
                placeholder="Short background blurb shown to students."
                value={form.bio}
                onChange={(e) => setForm({ ...form, bio: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Portrait attribution</label>
              <textarea
                className={`${inputCls} h-16 resize-none`}
                placeholder="Painter / source / license of the portrait image."
                value={form.attribution}
                onChange={(e) => setForm({ ...form, attribution: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Source URL</label>
              <input
                className={inputCls}
                placeholder="https://…"
                value={form.sourceUrl}
                onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })}
              />
            </div>
          </div>
          <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
            The registry joins pieces by their composer STRING — name and aliases must match
            the exact spellings used on pieces. It decorates the catalog only; deleting an
            entry never touches content.
          </p>
        </PanelSection>
      )}

      {!isCreate && (
        <PanelSection
          title="Usage"
          defaultOpen
          badge={`${entry!.usageCount} piece${entry!.usageCount === 1 ? "" : "s"}`}
        >
          {usedStrings.length === 0 ? (
            <p className="text-xs text-ink-faint leading-relaxed">
              No piece or work currently uses this name or its aliases.
            </p>
          ) : (
            usedStrings.map((s) => (
              <div key={s.value} className="flex items-center gap-2 py-1.5 border-b border-line/50 last:border-0">
                <span className="text-xs font-medium min-w-0 flex-1 truncate">{s.value}</span>
                <span className="text-[11px] text-ink-faint shrink-0">
                  {s.matched === "alias" ? "alias · " : ""}
                  {s.pieceCount} piece{s.pieceCount === 1 ? "" : "s"}
                  {s.workCount > 0 ? ` · ${s.workCount} work${s.workCount === 1 ? "" : "s"}` : ""}
                </span>
              </div>
            ))
          )}
        </PanelSection>
      )}

      <AlertDialog open={confirmApply} onOpenChange={(open) => { if (!open) setConfirmApply(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply these composer changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Name and alias edits change which pieces this entry decorates — the live catalog
              updates immediately.
              {entry && form && form.name.trim() !== entry.name && (
                <>
                  {" "}Renaming keeps "{entry.name}" as an alias automatically, so pieces still
                  carrying the old spelling stay matched.
                </>
              )}
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
            <AlertDialogTitle>Delete "{entry?.name}" from the registry?</AlertDialogTitle>
            <AlertDialogDescription>
              {entry && entry.usageCount > 0
                ? `This entry currently decorates ${entry.usageCount} piece${entry.usageCount === 1 ? "" : "s"}. `
                : "No piece currently uses this entry. "}
              Pieces keep their composer strings and nothing breaks — the app just falls back
              to a monogram where the portrait and details were shown.
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

      <AlertDialog open={discard} onOpenChange={(open) => { if (!open) setDiscard(false); }}>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>You have unapplied edits — discard them?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDiscard(false);
                onClose();
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
