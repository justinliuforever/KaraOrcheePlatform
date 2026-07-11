import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, type AdminBook, type AdminPiece, type AdminWork } from "../api";
import { ErrorNote, PageHeader, Spinner, thCls } from "../components/ui";
import StatusTag from "../components/StatusTag";
import DifficultyMeter from "../components/DifficultyMeter";
import PiecePanel from "../components/PiecePanel";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui-kit/card";
import { Input } from "@/components/ui-kit/input";
import { Button } from "@/components/ui-kit/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-kit/table";
import { timeAgo } from "../studio/gateInfo";

type SortKey = "title" | "composer" | "difficulty" | "publishedVersion" | "updatedAt";

interface Filters {
  status: string; // "" | published | archived | draft
  shelf: string; // "" | validated | experimental
  rights: string; // "" | public_domain | licensed | unknown | blocked
  book: string; // "" | none | <bookId>
  work: string; // "" | none | <workId>
  instrument: string; // "" | piano | violin | guitar
}

const NO_FILTERS: Filters = { status: "", shelf: "", rights: "", book: "", work: "", instrument: "" };

function soloOf(p: AdminPiece): string {
  return p.instrumentation?.solo ?? "piano";
}

function matches(p: AdminPiece, f: Filters): boolean {
  if (f.status && p.status !== f.status) return false;
  if (f.shelf && p.tracking !== f.shelf) return false;
  if (f.rights && p.rights !== f.rights) return false;
  if (f.book === "none" && p.bookId) return false;
  if (f.book && f.book !== "none" && p.bookId !== f.book) return false;
  if (f.work === "none" && p.workId) return false;
  if (f.work && f.work !== "none" && p.workId !== f.work) return false;
  if (f.instrument && soloOf(p) !== f.instrument) return false;
  return true;
}

function exportCsv(rows: AdminPiece[]) {
  const cols = ["id", "title", "composer", "subtitle", "instrument", "workId", "workIndex", "workTitle", "workCatalogue", "difficulty", "tracking", "bookId", "bookIndex", "rights", "status", "publishedVersion", "updatedAt"] as const;
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const enriched = rows.map((r) => ({ ...r, instrument: soloOf(r) }));
  const csv = [cols.join(","), ...enriched.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `pieces-library-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Library holds hundreds of rows — deliberately denser than the other tables.
const CELL = "px-4 py-2";

const SELECT_CLS =
  "rounded-lg border border-line bg-card pl-2.5 pr-7 py-2 text-sm outline-none focus:border-brand focus-visible:ring-[3px] focus-visible:ring-ring/30 appearance-none bg-no-repeat bg-[right_0.5rem_center] bg-[length:14px] bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 20 20%22 fill=%22%239aa0af%22%3E%3Cpath d=%22M5.5 7.5l4.5 5 4.5-5z%22/%3E%3C/svg%3E')]";

export default function PiecesPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("sel");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "updatedAt", dir: -1 });
  const searchRef = useRef<HTMLInputElement>(null);

  const query = useQuery<{ items: AdminPiece[] }, Error>({
    queryKey: ["pieces"],
    queryFn: () => api("/admin/pieces"),
  });
  const booksQ = useQuery<{ items: AdminBook[] }, Error>({
    queryKey: ["books"],
    queryFn: () => api("/admin/books"),
  });
  const worksQ = useQuery<{ items: AdminWork[] }, Error>({
    queryKey: ["works"],
    queryFn: () => api("/admin/works"),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA" &&
        // Don't steal '/' while the slide-over panel (or any Radix overlay) is open.
        !document.querySelector('[data-state="open"]')
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = (query.data?.items ?? [])
      .filter(
        (p) =>
          !needle ||
          p.id.toLowerCase().includes(needle) ||
          p.title.toLowerCase().includes(needle) ||
          p.composer.toLowerCase().includes(needle) ||
          (p.subtitle ?? "").toLowerCase().includes(needle) ||
          (p.workTitle ?? "").toLowerCase().includes(needle) ||
          (p.workCatalogue ?? "").toLowerCase().includes(needle) ||
          (p.workId ?? "").toLowerCase().includes(needle),
      )
      .filter((p) => matches(p, filters));
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

  const dirty = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

  function sortHeader(key: SortKey, label: string, extra = "") {
    const active = sort.key === key;
    return (
      <TableHead className={cn(thCls, extra)}>
        <button
          className={`inline-flex items-center gap-1 uppercase tracking-wide text-xs font-medium rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${active ? "text-ink" : "text-ink-faint hover:text-ink-soft"}`}
          onClick={() => setSort(active ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: 1 })}
        >
          {label}
          {active && <span aria-hidden>{sort.dir === 1 ? "↑" : "↓"}</span>}
        </button>
      </TableHead>
    );
  }

  return (
    <>
      <PageHeader
        title="Pieces Library"
        subtitle={query.data ? `${query.data.items.length} pieces in the registry · ${query.data.items.filter((p) => p.status === "published").length} live in the app` : undefined}
        right={
          <Button variant="outline" onClick={() => exportCsv(items)}>
            Export CSV
          </Button>
        }
      />

      <div className="flex items-center gap-2 mb-4 rounded-xl border border-line bg-card px-3 py-2.5 flex-wrap">
        <Input
          ref={searchRef}
          className="flex-1 w-auto min-w-52 rounded-lg bg-paper/60 border-transparent text-sm"
          placeholder="Search title, composer, id…  ( / )"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className={SELECT_CLS} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">Status: all</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
        <select className={SELECT_CLS} value={filters.shelf} onChange={(e) => setFilters({ ...filters, shelf: e.target.value })}>
          <option value="">Shelf: all</option>
          <option value="validated">Pieces</option>
          <option value="experimental">Challenge</option>
        </select>
        <select className={SELECT_CLS} value={filters.rights} onChange={(e) => setFilters({ ...filters, rights: e.target.value })}>
          <option value="">Rights: all</option>
          <option value="public_domain">Public domain</option>
          <option value="licensed">Licensed</option>
          <option value="unknown">Unknown</option>
          <option value="blocked">Blocked</option>
        </select>
        <select className={SELECT_CLS} value={filters.instrument} onChange={(e) => setFilters({ ...filters, instrument: e.target.value })}>
          <option value="">Instrument: all</option>
          <option value="piano">Piano</option>
          <option value="violin">Violin</option>
          <option value="guitar">Guitar</option>
        </select>
        <select className={SELECT_CLS} value={filters.work} onChange={(e) => setFilters({ ...filters, work: e.target.value })}>
          <option value="">Work: all</option>
          <option value="none">Standalone (no work)</option>
          {worksQ.data?.items.map((w) => (
            <option key={w.id} value={w.id}>
              {w.composer.split(" ").pop()} · {w.catalogue ?? w.title}
            </option>
          ))}
        </select>
        <select className={SELECT_CLS} value={filters.book} onChange={(e) => setFilters({ ...filters, book: e.target.value })}>
          <option value="">Book: all</option>
          <option value="none">No book</option>
          {booksQ.data?.items.map((b) => (
            <option key={b.id} value={b.id}>{b.title}</option>
          ))}
        </select>
        {(dirty || q) && (
          <button
            className="text-xs text-ink-soft hover:text-ink px-1.5 py-1 rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => {
              setFilters(NO_FILTERS);
              setQ("");
            }}
          >
            ✕ Reset
          </button>
        )}
      </div>

      {query.isPending && <Spinner />}
      {query.isError && <ErrorNote message={query.error.message} />}
      {query.data && items.length === 0 && (
        <Card className="items-center gap-1 p-10 text-center">
          <p className="text-sm font-medium">No pieces match</p>
          <p className="text-sm text-ink-soft">
            {q || dirty
              ? "Try a different search, or clear the filters below."
              : "The library fills up as Studio builds are published."}
          </p>
          {(q || dirty) && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                setFilters(NO_FILTERS);
                setQ("");
              }}
            >
              Clear search & filters
            </Button>
          )}
        </Card>
      )}
      {items.length > 0 && (
        <Card className="overflow-hidden p-0 gap-0">
          <Table>
            <TableHeader>
              <TableRow>
                {sortHeader("title", "Piece")}
                {sortHeader("composer", "Composer")}
                <TableHead className={thCls}>Work</TableHead>
                <TableHead className={thCls}>Book</TableHead>
                {sortHeader("difficulty", "Diff", "text-right")}
                <TableHead className={thCls}>Shelf</TableHead>
                <TableHead className={thCls}>Rights</TableHead>
                <TableHead className={thCls}>Status</TableHead>
                {sortHeader("publishedVersion", "Ver", "text-right")}
                {sortHeader("updatedAt", "Updated", "text-right")}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow
                  key={p.id}
                  className={cn("cursor-pointer", selected === p.id && "bg-brand-soft/40 hover:bg-brand-soft/50")}
                  onClick={() => setParams({ sel: p.id })}
                >
                  <TableCell className={`${CELL} font-medium whitespace-normal`}>
                    {p.title}
                    {p.subtitle && <span className="text-ink-soft font-normal"> · {p.subtitle}</span>}
                    <span className="block text-[11px] font-mono text-ink-faint">{p.id}</span>
                  </TableCell>
                  <TableCell className={`${CELL} text-ink-soft whitespace-normal`}>
                    {p.composer}
                    {soloOf(p) !== "piano" && (
                      <span className="block text-[11px] text-brand">{soloOf(p)}</span>
                    )}
                  </TableCell>
                  <TableCell className={`${CELL} text-ink-soft`}>
                    {p.workId ? (
                      <>
                        {p.workCatalogue ?? p.workTitle ?? p.workId}
                        {p.workIndex != null && <span className="text-ink-faint"> · No.{p.workIndex}</span>}
                        {p.workCatalogue && p.workTitle && (
                          <span className="block text-[11px] text-ink-faint truncate max-w-40" title={p.workTitle}>
                            {p.workTitle}
                          </span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className={`${CELL} text-ink-soft`}>
                    {p.bookTitle ? `${p.bookTitle}${p.bookIndex != null ? ` #${p.bookIndex}` : ""}` : "—"}
                  </TableCell>
                  <TableCell className={`${CELL} text-right`}>
                    <div className="flex justify-end">
                      <DifficultyMeter value={p.difficulty} />
                    </div>
                  </TableCell>
                  <TableCell className={CELL}>
                    <StatusTag
                      value={p.tracking}
                      family="shelf"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFilters({ ...filters, shelf: p.tracking });
                      }}
                    />
                  </TableCell>
                  <TableCell className={CELL}>
                    <StatusTag
                      value={p.rights}
                      family="rights"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFilters({ ...filters, rights: p.rights });
                      }}
                    />
                  </TableCell>
                  <TableCell className={CELL}>
                    <StatusTag
                      value={p.status}
                      family="lifecycle"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFilters({ ...filters, status: p.status });
                      }}
                    />
                  </TableCell>
                  <TableCell className={`${CELL} text-right tabular-nums text-ink-soft`}>
                    {p.publishedVersion != null ? `v${p.publishedVersion}` : "—"}
                  </TableCell>
                  <TableCell className={`${CELL} text-right text-xs text-ink-soft tabular-nums`}>
                    <span title={new Date(p.updatedAt).toLocaleString()}>{timeAgo(p.updatedAt)}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
