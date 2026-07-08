import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, type AdminPiece } from "../api";
import { Badge, Card, ErrorNote, PageHeader, Spinner, Td, Th, rightsTone, statusTone } from "../components/ui";
import PiecePanel from "../components/PiecePanel";
import { timeAgo } from "../studio/gateInfo";

type SortKey = "title" | "composer" | "difficulty" | "publishedVersion" | "updatedAt";

const FILTERS: { key: string; label: string; test: (p: AdminPiece) => boolean }[] = [
  { key: "published", label: "Published", test: (p) => p.status === "published" },
  { key: "archived", label: "Archived", test: (p) => p.status === "archived" },
  { key: "validated", label: "Pieces shelf", test: (p) => p.tracking === "validated" },
  { key: "experimental", label: "Challenge shelf", test: (p) => p.tracking === "experimental" },
  { key: "in_book", label: "In a book", test: (p) => !!p.bookId },
  { key: "rights_attention", label: "Rights attention", test: (p) => p.rights === "unknown" || p.rights === "blocked" },
];

function exportCsv(rows: AdminPiece[]) {
  const cols = ["id", "title", "composer", "subtitle", "difficulty", "tracking", "bookId", "bookIndex", "rights", "status", "publishedVersion", "updatedAt"] as const;
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `pieces-library-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function PiecesPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("sel");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "updatedAt", dir: -1 });
  const searchRef = useRef<HTMLInputElement>(null);

  const query = useQuery<{ items: AdminPiece[] }, Error>({
    queryKey: ["pieces"],
    queryFn: () => api("/admin/pieces"),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const active = FILTERS.filter((f) => filters.has(f.key));
    const rows = (query.data?.items ?? [])
      .filter(
        (p) =>
          !needle ||
          p.id.toLowerCase().includes(needle) ||
          p.title.toLowerCase().includes(needle) ||
          p.composer.toLowerCase().includes(needle) ||
          (p.subtitle ?? "").toLowerCase().includes(needle),
      )
      .filter((p) => active.every((f) => f.test(p)));
    const dir = sort.dir;
    return [...rows].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [query.data, q, filters, sort]);

  function sortHeader(key: SortKey, label: string, extra = "") {
    const active = sort.key === key;
    return (
      <Th className={extra}>
        <button
          className={`inline-flex items-center gap-1 uppercase tracking-wide text-xs font-medium ${active ? "text-ink" : "text-ink-faint hover:text-ink-soft"}`}
          onClick={() => setSort(active ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: 1 })}
        >
          {label}
          {active && <span>{sort.dir === 1 ? "↑" : "↓"}</span>}
        </button>
      </Th>
    );
  }

  return (
    <>
      <PageHeader
        title="Pieces Library"
        subtitle={query.data ? `${query.data.items.length} pieces in the registry · ${query.data.items.filter((p) => p.status === "published").length} live in the app` : undefined}
        right={
          <button
            className="rounded-lg border border-line text-sm font-medium px-3.5 py-2 hover:bg-paper"
            onClick={() => exportCsv(items)}
          >
            Export CSV
          </button>
        }
      />

      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex gap-1.5 flex-wrap">
          {FILTERS.map((f) => {
            const on = filters.has(f.key);
            return (
              <button
                key={f.key}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  on ? "border-brand bg-brand-soft text-brand" : "border-line text-ink-soft hover:border-brand/40"
                }`}
                onClick={() => {
                  const next = new Set(filters);
                  if (on) next.delete(f.key);
                  else next.add(f.key);
                  setFilters(next);
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <input
          ref={searchRef}
          className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm w-64 outline-none focus:border-brand"
          placeholder="Search title, composer, id…  ( / )"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {query.isPending && <Spinner />}
      {query.isError && <ErrorNote message={query.error.message} />}
      {query.data && items.length === 0 && (
        <Card className="p-10 text-center text-sm text-ink-soft">No pieces match.</Card>
      )}
      {items.length > 0 && (
        <Card>
          <table className="w-full">
            <thead>
              <tr>
                {sortHeader("title", "Piece")}
                {sortHeader("composer", "Composer")}
                <Th>Book</Th>
                {sortHeader("difficulty", "Diff")}
                <Th>Shelf</Th>
                <Th>Rights</Th>
                <Th>Status</Th>
                {sortHeader("publishedVersion", "Ver", "text-right")}
                {sortHeader("updatedAt", "Updated", "text-right")}
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr
                  key={p.id}
                  className={`hover:bg-paper/60 cursor-pointer ${selected === p.id ? "bg-brand-soft/40" : ""}`}
                  onClick={() => setParams({ sel: p.id })}
                >
                  <Td className="font-medium">
                    {p.title}
                    {p.subtitle && <span className="text-ink-soft font-normal"> · {p.subtitle}</span>}
                    <span className="block text-[11px] font-mono text-ink-faint">{p.id}</span>
                  </Td>
                  <Td className="text-ink-soft">{p.composer}</Td>
                  <Td className="text-ink-soft">
                    {p.bookTitle ? `${p.bookTitle}${p.bookIndex != null ? ` #${p.bookIndex}` : ""}` : "—"}
                  </Td>
                  <Td className="tabular-nums">{p.difficulty ?? "—"}</Td>
                  <Td>
                    <Badge tone={p.tracking === "validated" ? "ok" : "muted"}>
                      {p.tracking === "validated" ? "Pieces" : "Challenge"}
                    </Badge>
                  </Td>
                  <Td>
                    <Badge tone={rightsTone(p.rights)}>{p.rights.replace("_", " ")}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums text-ink-soft">
                    {p.publishedVersion != null ? `v${p.publishedVersion}` : "—"}
                  </Td>
                  <Td className="text-right text-xs text-ink-soft tabular-nums">
                    <span title={new Date(p.updatedAt).toLocaleString()}>{timeAgo(p.updatedAt)}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {selected && (
        <PiecePanel
          id={selected}
          onClose={() => {
            params.delete("sel");
            setParams(params);
          }}
        />
      )}
    </>
  );
}
