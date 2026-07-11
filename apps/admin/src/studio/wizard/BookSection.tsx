import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiForm, type AdminBook, type CheckFinding, type StudioMetadata } from "../../api";
import { ErrorNote, inputCls } from "../../components/ui";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import { Input } from "@/components/ui-kit/input";
import { Label } from "@/components/ui-kit/label";
import FilePick from "./FilePick";
import { FindingRow, labelCls } from "./shared";
import { validateCoverFile } from "../../lib/coverValidation";

export default function BookSection({
  meta,
  books,
  findings,
  onChange,
  onBooksChanged,
}: {
  meta: StudioMetadata;
  books: AdminBook[];
  findings: CheckFinding[];
  onChange: (book: StudioMetadata["book"]) => void;
  onBooksChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newAuthor, setNewAuthor] = useState("");
  const [cover, setCover] = useState<File | null>(null);
  const [coverErr, setCoverErr] = useState<string | null>(null);
  // The number can be typed while the book is still being created — it attaches the
  // moment the book exists (a dead/disabled input here read as "can't type numbers").
  const [pendingIndex, setPendingIndex] = useState("");

  const selected = meta.book ? books.find((b) => b.id === meta.book!.id) : undefined;

  const createBook = useMutation<AdminBook, Error>({
    mutationFn: () => {
      const form = new FormData();
      form.set("title", newTitle);
      if (newAuthor) form.set("author", newAuthor);
      form.set("cover", cover!);
      return apiForm<AdminBook>("/admin/books", form);
    },
    onSuccess: (book) => {
      setCreating(false);
      setNewTitle("");
      setNewAuthor("");
      setCover(null);
      onBooksChanged();
      onChange({ id: book.id, index: pendingIndex !== "" ? Number(pendingIndex) : (meta.book?.index ?? null) });
      setPendingIndex("");
    },
  });

  return (
    <Card className="block p-5 space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">3 · Book (optional)</p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className={labelCls}>Method book / collection</Label>
          <select
            className={inputCls}
            value={creating ? "__new__" : (meta.book?.id ?? "")}
            onChange={(e) => {
              if (e.target.value === "__new__") {
                setCreating(true);
              } else {
                setCreating(false);
                const idx = meta.book?.index ?? (pendingIndex !== "" ? Number(pendingIndex) : null);
                setPendingIndex("");
                onChange(e.target.value ? { id: e.target.value, index: idx } : null);
              }
            }}
          >
            <option value="">none</option>
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
                {b.pieceCount ? ` (${b.pieceCount})` : ""}
              </option>
            ))}
            <option value="__new__">+ new book…</option>
          </select>
        </div>
        <div>
          <Label className={labelCls}>Number in book</Label>
          <Input
            type="number"
            placeholder="41"
            value={meta.book ? (meta.book.index ?? "") : pendingIndex}
            disabled={!meta.book && !creating}
            onChange={(e) => {
              if (meta.book) {
                onChange({ ...meta.book, index: e.target.value !== "" ? Number(e.target.value) : null });
              } else {
                setPendingIndex(e.target.value);
              }
            }}
          />
          {creating && !meta.book && pendingIndex !== "" && (
            <p className="text-[11px] text-ink-faint mt-1">Will attach as No. {pendingIndex} once the book is created.</p>
          )}
        </div>
      </div>

      {selected && (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-paper/50 px-3 py-2.5">
          {selected.coverThumbUrl ? (
            <img src={selected.coverThumbUrl} alt="" className="w-9 h-12 rounded object-cover border border-line" />
          ) : (
            <div className="w-9 h-12 rounded bg-line grid place-items-center text-[10px] text-ink-faint">no cover</div>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{selected.title}</p>
            <p className="text-[11px] text-ink-faint">
              {selected.pieceCount} piece{selected.pieceCount === 1 ? "" : "s"} in the library
              {!selected.coverThumbUrl && " · cover missing — add one on the Collections page"}
            </p>
          </div>
        </div>
      )}

      {creating && (
        <div className="rounded-lg border border-line bg-paper/40 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className={labelCls}>Book title</Label>
              <Input placeholder="Practical Method, Op. 599" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </div>
            <div>
              <Label className={labelCls}>Author (optional)</Label>
              <Input placeholder="Carl Czerny" value={newAuthor} onChange={(e) => setNewAuthor(e.target.value)} />
            </div>
          </div>
          <div>
            <Label className={labelCls}>
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
          {createBook.isError && <ErrorNote message={createBook.error.message} />}
          <div className="flex gap-2">
            <Button
              disabled={!newTitle.trim() || !cover || createBook.isPending}
              onClick={() => createBook.mutate()}
            >
              {createBook.isPending ? "Creating…" : "Create book"}
            </Button>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {findings.map((f, i) => (
        <FindingRow key={i} f={f} />
      ))}
    </Card>
  );
}
