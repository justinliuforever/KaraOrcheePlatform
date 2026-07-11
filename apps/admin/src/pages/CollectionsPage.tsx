import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, createBook, searchWorks, type AdminBook, type AdminWork } from "../api";
import { ErrorNote, PageHeader, Spinner, thCls } from "../components/ui";
import StatusTag from "../components/StatusTag";
import BookPanel from "../components/BookPanel";
import WorkPanel from "../components/WorkPanel";
import FilePick from "../studio/wizard/FilePick";
import { validateCoverFile } from "../lib/coverValidation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import { Input } from "@/components/ui-kit/input";
import { Label } from "@/components/ui-kit/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui-kit/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-kit/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui-kit/tabs";
import { timeAgo } from "../studio/gateInfo";

export default function CollectionsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "works" ? "works" : "books";
  const selected = params.get("sel");
  const [newBookOpen, setNewBookOpen] = useState(false);

  const booksQ = useQuery<{ items: AdminBook[] }, Error>({
    queryKey: ["books"],
    queryFn: () => api("/admin/books"),
  });

  const [workSearch, setWorkSearch] = useState("");
  const [workQ, setWorkQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setWorkQ(workSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [workSearch]);
  const worksQ = useQuery<{ items: AdminWork[] }, Error>({
    // Empty search shares the app-wide ["works"] list cache; a q gets its own key.
    queryKey: workQ ? ["works", workQ] : ["works"],
    queryFn: () => searchWorks(workQ),
    placeholderData: keepPreviousData,
    enabled: tab === "works",
  });

  const missingCovers = booksQ.data?.items.filter((b) => !b.coverThumbUrl).length ?? 0;

  return (
    <>
      <PageHeader
        title="Collections"
        subtitle={
          tab === "books"
            ? booksQ.data
              ? `${booksQ.data.items.length} book${booksQ.data.items.length === 1 ? "" : "s"} on the app bookshelf${missingCovers > 0 ? ` · ${missingCovers} missing a cover` : ""}`
              : undefined
            : worksQ.data
              ? `${worksQ.data.items.length} work${worksQ.data.items.length === 1 ? "" : "s"}${workQ ? " matching" : ""} · compositions grouping their movements`
              : undefined
        }
        right={
          tab === "books" ? (
            <Button onClick={() => setNewBookOpen(true)}>New book</Button>
          ) : undefined
        }
      />

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Tabs
          value={tab}
          onValueChange={(v) => setParams(v === "works" ? { tab: "works" } : {})}
        >
          <TabsList>
            <TabsTrigger value="books">Books</TabsTrigger>
            <TabsTrigger value="works">Works</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "works" && (
          <Input
            className="w-72"
            placeholder="Search title, composer, catalogue no.…"
            value={workSearch}
            onChange={(e) => setWorkSearch(e.target.value)}
          />
        )}
      </div>

      {tab === "books" && (
        <>
          {booksQ.isPending && <Spinner />}
          {booksQ.isError && <ErrorNote message={booksQ.error.message} />}
          {booksQ.data && booksQ.data.items.length === 0 && (
            <Card className="items-center gap-1 p-10 text-center">
              <p className="text-sm font-medium">No books yet</p>
              <p className="text-sm text-ink-soft">
                Books are the app's bookshelf — create one here, or one appears implicitly when
                a piece is published into a new book.
              </p>
              <Button size="sm" className="mt-2" onClick={() => setNewBookOpen(true)}>
                New book
              </Button>
            </Card>
          )}
          {booksQ.data && booksQ.data.items.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-4">
              {booksQ.data.items.map((b) => (
                <button
                  key={b.id}
                  className={cn(
                    "group text-left rounded-xl border border-line bg-card p-3 hover:border-brand/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    selected === b.id && "border-brand",
                  )}
                  onClick={() => setParams({ sel: b.id })}
                >
                  <div className="relative aspect-[3/4] w-full overflow-hidden rounded-lg border border-line bg-paper mb-2.5">
                    {b.coverThumbUrl ? (
                      <img
                        src={b.coverThumbUrl}
                        alt=""
                        loading="lazy"
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : (
                      <>
                        <div className="absolute inset-0 grid place-items-center px-3 text-center text-xs text-ink-faint">
                          no cover
                        </div>
                        <span className="absolute left-2 top-2 rounded-full bg-bad px-2 py-0.5 text-xs font-medium text-white">
                          Cover missing
                        </span>
                      </>
                    )}
                  </div>
                  <p className="text-sm font-medium truncate" title={b.title}>{b.title}</p>
                  <p className="text-xs text-ink-soft truncate">{b.author ?? "—"}</p>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-faint tabular-nums">
                      {b.pieceCount} piece{b.pieceCount === 1 ? "" : "s"}
                    </span>
                    <StatusTag value={b.rights} family="rights" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "works" && (
        <>
          {worksQ.isPending && <Spinner />}
          {worksQ.isError && <ErrorNote message={worksQ.error.message} />}
          {worksQ.data && worksQ.data.items.length === 0 && (
            <Card className="items-center gap-1 p-10 text-center">
              <p className="text-sm font-medium">{workQ ? "No works match" : "No works yet"}</p>
              <p className="text-sm text-ink-soft">
                {workQ
                  ? "Try a different search."
                  : "Works are created during upload in the Studio wizard when a piece is a movement of a composition."}
              </p>
            </Card>
          )}
          {worksQ.data && worksQ.data.items.length > 0 && (
            <Card className="overflow-hidden p-0 gap-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={thCls}>Work</TableHead>
                    <TableHead className={thCls}>Composer</TableHead>
                    <TableHead className={thCls}>Catalogue</TableHead>
                    <TableHead className={thCls}>Type</TableHead>
                    <TableHead className={`${thCls} text-right`}>Pieces</TableHead>
                    <TableHead className={`${thCls} text-right`}>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {worksQ.data.items.map((w) => (
                    <TableRow
                      key={w.id}
                      className={cn("cursor-pointer", selected === w.id && "bg-brand-soft/40 hover:bg-brand-soft/50")}
                      onClick={() => setParams({ tab: "works", sel: w.id })}
                    >
                      <TableCell className="px-4 py-2 font-medium whitespace-normal">
                        {w.title}
                        <span className="block text-[11px] font-mono text-ink-faint">{w.id}</span>
                      </TableCell>
                      <TableCell className="px-4 py-2 text-ink-soft whitespace-normal">{w.composer}</TableCell>
                      <TableCell className="px-4 py-2 text-ink-soft">{w.catalogue ?? "—"}</TableCell>
                      <TableCell className="px-4 py-2 text-ink-soft">{w.workType.replaceAll("_", " ")}</TableCell>
                      <TableCell className="px-4 py-2 text-right tabular-nums text-ink-soft">
                        {w.pieceCount ?? 0}
                      </TableCell>
                      <TableCell className="px-4 py-2 text-right text-xs text-ink-soft tabular-nums">
                        <span title={new Date(w.updatedAt).toLocaleString()}>{timeAgo(w.updatedAt)}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}

      <NewBookDialog open={newBookOpen} onOpenChange={setNewBookOpen} />

      {selected && tab === "books" && (
        <BookPanel
          key={selected}
          id={selected}
          onClose={() => {
            params.delete("sel");
            setParams(params);
          }}
        />
      )}
      {selected && tab === "works" && (
        <WorkPanel
          key={selected}
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

function NewBookDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [cover, setCover] = useState<File | null>(null);
  const [coverErr, setCoverErr] = useState<string | null>(null);

  const create = useMutation<Omit<AdminBook, "pieceCount">, Error>({
    mutationFn: () => createBook({ title: title.trim(), author: author.trim() || undefined }, cover!),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ["books"] });
      toast.success(`"${b.title}" added to the shelf`);
      onOpenChange(false);
      setTitle("");
      setAuthor("");
      setCover(null);
      setCoverErr(null);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New book</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="mb-1.5">Book title</Label>
            <Input
              placeholder="Practical Method, Op. 599"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <Label className="mb-1.5">Author (optional)</Label>
            <Input placeholder="Carl Czerny" value={author} onChange={(e) => setAuthor(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1.5">
              Cover image <span className="text-bad">*</span> — portrait 3:4, at least 900×1200, JPEG/PNG/WebP
            </Label>
            <FilePick
              label="Book cover"
              accept="image/jpeg,image/png,image/webp"
              hint="Shown on the app's bookshelf — make your own artwork, don't scan a publisher's cover"
              file={cover}
              onFile={async (f) => {
                setCoverErr(null);
                if (f) {
                  const err = await validateCoverFile(f);
                  if (err) {
                    setCoverErr(err);
                    setCover(null);
                    return;
                  }
                }
                setCover(f);
              }}
            />
            {coverErr && <p className="text-xs text-bad mt-1.5">{coverErr}</p>}
          </div>
          {create.isError && <ErrorNote message={create.error.message} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!title.trim() || !cover || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Create book"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
