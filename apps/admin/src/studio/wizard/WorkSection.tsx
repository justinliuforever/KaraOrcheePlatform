import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type AdminWork, type CheckFinding, type StudioMetadata } from "../../api";
import { ErrorNote, inputCls } from "../../components/ui";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import { Input } from "@/components/ui-kit/input";
import { Label } from "@/components/ui-kit/label";
import { FindingRow, labelCls } from "./shared";

/** Roman/Arabic movement-number auto-suggest from the subtitle ("I. Allegro" → 1). */
function suggestIndex(subtitle: string | undefined): number | null {
  if (!subtitle) return null;
  const roman = subtitle.match(/^\s*(X{0,3}(?:IX|IV|V?I{0,3}))[.\s]/i);
  if (roman && roman[1]) {
    const map: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
    const v = map[roman[1].toLowerCase()];
    if (v) return v;
  }
  const arabic = subtitle.match(/(?:no\.?|nr\.?|#)\s*(\d{1,3})/i) ?? subtitle.match(/^\s*(\d{1,3})[.\s]/);
  return arabic ? Number(arabic[1]) : null;
}

/** Work lane: search-or-create the musical composition this piece is a movement of.
 * BOOK = a method/exam publication you practice THROUGH (has a cover).
 * WORK = a composition an artist would PROGRAM (sonata, étude set, WTC) — even if its
 * title contains the word "Book". Both can apply at once. */
export default function WorkSection({
  meta,
  onChange,
  findings,
}: {
  meta: StudioMetadata;
  onChange: (work: StudioMetadata["work"]) => void;
  findings: CheckFinding[];
}) {
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newCatalogue, setNewCatalogue] = useState("");
  const [newType, setNewType] = useState("sonata");
  const [createFindings, setCreateFindings] = useState<CheckFinding[]>([]);

  const searchQ = useQuery<{ items: AdminWork[] }, Error>({
    queryKey: ["works", q],
    queryFn: () => api(`/admin/works?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 0 || !!meta.work,
  });
  const selected = meta.work ? searchQ.data?.items.find((w) => w.id === meta.work!.id) : undefined;
  const selQ = useQuery<{ items: AdminWork[] }, Error>({
    queryKey: ["works", "sel", meta.work?.id],
    queryFn: () => api(`/admin/works?q=${encodeURIComponent(meta.work!.id.replaceAll("_", " ").split(" ").pop() ?? "")}`),
    enabled: !!meta.work && !selected,
  });
  const selectedWork = selected ?? selQ.data?.items.find((w) => w.id === meta.work?.id);

  const createWork = useMutation<AdminWork, Error>({
    mutationFn: () =>
      api("/admin/works", {
        method: "POST",
        body: JSON.stringify({
          title: newTitle,
          composer: meta.composer ?? "",
          catalogue: newCatalogue || null,
          workType: newType,
        }),
      }),
    onSuccess: (w) => {
      setCreating(false);
      setCreateFindings([]);
      onChange({ id: w.id, index: meta.work?.index ?? suggestIndex(meta.subtitle) });
    },
  });

  async function checkNewWork() {
    if (!newCatalogue || !meta.composer) return;
    const res = await api<{ findings: CheckFinding[] }>("/admin/studio/checks", {
      method: "POST",
      body: JSON.stringify({ composer: meta.composer, work: { catalogue: newCatalogue } }),
    });
    setCreateFindings(res.findings);
  }

  return (
    <Card className="block p-5 space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">3 · Work (optional)</p>
        <p className="text-[11px] text-ink-faint mt-1 leading-relaxed">
          The COMPOSITION this piece is a movement/number of — a sonata, étude set, or
          prelude+fugue pair that a performer would program. (Method books you practice
          <em> through</em> belong in the Book section below; both can apply at once.)
        </p>
      </div>

      {!meta.work && !creating && (
        <div>
          <Label className={labelCls}>Search works (title / composer / catalogue no.)</Label>
          <Input
            placeholder="e.g. K. 330 or Sonata"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q.trim() && (
            <div className="mt-2 rounded-lg border border-line divide-y divide-line max-h-44 overflow-y-auto">
              {(searchQ.data?.items ?? []).map((w) => (
                <button
                  key={w.id}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-paper"
                  onClick={() => {
                    onChange({ id: w.id, index: suggestIndex(meta.subtitle) });
                    setQ("");
                  }}
                >
                  <span className="font-medium">{w.title}</span>
                  <span className="text-ink-faint text-xs"> · {w.composer}{w.catalogue ? ` · ${w.catalogue}` : ""} · {w.pieceCount ?? 0} piece{(w.pieceCount ?? 0) === 1 ? "" : "s"}</span>
                </button>
              ))}
              <button
                className="w-full text-left px-3 py-2 text-sm text-brand font-medium hover:bg-paper"
                onClick={() => {
                  setCreating(true);
                  setNewTitle(q);
                  setQ("");
                }}
              >
                + Create a new work…
              </button>
            </div>
          )}
        </div>
      )}

      {creating && (
        <div className="rounded-lg border border-line bg-paper/40 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className={labelCls}>Work title</Label>
              <Input placeholder="Piano Sonata No. 13 in C major" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </div>
            <div>
              <Label className={labelCls}>Catalogue No. (Op. / K. / BWV / Hob. / D.)</Label>
              <Input
                placeholder="K. 330"
                value={newCatalogue}
                onChange={(e) => setNewCatalogue(e.target.value)}
                onBlur={() => void checkNewWork()}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className={labelCls}>Type</Label>
              <select className={inputCls} value={newType} onChange={(e) => setNewType(e.target.value)}>
                {["sonata", "suite", "etude_set", "prelude_fugue", "variations", "cycle", "concerto", "collection", "other"].map((t) => (
                  <option key={t} value={t}>{t.replaceAll("_", " ")}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <p className="text-[11px] text-ink-faint pb-2">Composer: {meta.composer || "(fill in Piece info first)"}</p>
            </div>
          </div>
          {createFindings.map((f, i) => (
            <FindingRow key={i} f={f} />
          ))}
          {createWork.isError && <ErrorNote message={createWork.error.message} />}
          <div className="flex gap-2">
            <Button
              disabled={!newTitle.trim() || !meta.composer || createWork.isPending || createFindings.some((f) => f.level === "error")}
              onClick={() => createWork.mutate()}
            >
              {createWork.isPending ? "Creating…" : "Create work"}
            </Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {meta.work && (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-line bg-paper/50 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">
                {selectedWork?.title ?? meta.work.id}
                {selectedWork?.catalogue && <span className="text-ink-soft font-normal"> · {selectedWork.catalogue}</span>}
              </p>
              <p className="text-[11px] text-ink-faint font-mono">{meta.work.id}</p>
            </div>
            <Button
              variant="ghost"
              size="xs"
              className="shrink-0 ml-3 text-ink-soft hover:text-bad"
              onClick={() => onChange(null)}
            >
              ✕ detach
            </Button>
          </div>
          <div className="w-44">
            <Label className={labelCls}>Movement / number in work</Label>
            <Input
              type="number"
              placeholder={String(suggestIndex(meta.subtitle) ?? "")}
              value={meta.work.index ?? ""}
              onChange={(e) =>
                onChange({ id: meta.work!.id, index: e.target.value ? Number(e.target.value) : null })
              }
            />
          </div>
        </div>
      )}

      {findings.map((f, i) => (
        <FindingRow key={i} f={f} />
      ))}
    </Card>
  );
}
