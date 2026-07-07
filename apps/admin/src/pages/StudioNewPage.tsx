import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api, createStudioJob, type AdminBook, type StudioJob } from "../api";
import { Card, ErrorNote, PageHeader } from "../components/ui";

const input =
  "w-full rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none focus:border-brand";
const label = "block text-xs font-medium text-ink-soft mb-1.5";

export default function StudioNewPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const books = useQuery<{ items: AdminBook[] }, Error>({
    queryKey: ["books"],
    queryFn: () => api("/admin/books"),
  });

  const [pieceId, setPieceId] = useState("");
  const [title, setTitle] = useState("");
  const [composer, setComposer] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [difficulty, setDifficulty] = useState<string>("");
  const [tracking, setTracking] = useState("experimental");
  const [rights, setRights] = useState("public_domain");
  const [rightsNote, setRightsNote] = useState("");
  const [bookId, setBookId] = useState("");
  const [newBookId, setNewBookId] = useState("");
  const [newBookTitle, setNewBookTitle] = useState("");
  const [bookIndex, setBookIndex] = useState("");
  const [musicxml, setMusicxml] = useState<File | null>(null);
  const [midi, setMidi] = useState<File | null>(null);

  const create = useMutation<StudioJob, Error>({
    mutationFn: async () => {
      const form = new FormData();
      const book =
        bookId === "__new__"
          ? { id: newBookId, title: newBookTitle, index: bookIndex ? Number(bookIndex) : null }
          : bookId
            ? { id: bookId, index: bookIndex ? Number(bookIndex) : null }
            : null;
      form.set(
        "metadata",
        JSON.stringify({
          pieceId,
          title,
          composer,
          subtitle,
          difficulty: difficulty ? Number(difficulty) : null,
          tracking,
          rights,
          rightsNote,
          book,
        }),
      );
      form.set("musicxml", musicxml!);
      if (midi) form.set("midi", midi);
      return createStudioJob(form);
    },
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: ["studio-jobs"] });
      nav(`/studio/${job.id}`);
    },
  });

  const slugOk = /^[a-z0-9][a-z0-9_]{2,63}$/.test(pieceId);
  const canSubmit =
    slugOk && title && composer && musicxml && !create.isPending &&
    (bookId !== "__new__" || (newBookId && newBookTitle));

  return (
    <>
      <div className="mb-4">
        <Link to="/studio" className="text-sm text-brand hover:underline">
          ← Studio
        </Link>
      </div>
      <PageHeader
        title="New piece"
        subtitle="MusicXML is required. Add the reference MIDI when you have one — it becomes the followed timeline; without it the notated score at its written tempo is used."
      />
      <div className="max-w-2xl space-y-4">
        <Card className="p-5 space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Files</p>
          <div>
            <label className={label}>MusicXML (.musicxml / .xml / .mxl) — required</label>
            <input
              type="file"
              accept=".musicxml,.xml,.mxl"
              className="text-sm"
              onChange={(e) => setMusicxml(e.target.files?.[0] ?? null)}
            />
          </div>
          <div>
            <label className={label}>Reference MIDI (.mid / .midi) — recommended</label>
            <input
              type="file"
              accept=".mid,.midi"
              className="text-sm"
              onChange={(e) => setMidi(e.target.files?.[0] ?? null)}
            />
          </div>
        </Card>

        <Card className="p-5 space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Catalog metadata</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={label}>Piece ID (slug, permanent)</label>
              <input
                className={`${input} font-mono ${pieceId && !slugOk ? "border-bad" : ""}`}
                placeholder="clementi_op36_1"
                value={pieceId}
                onChange={(e) => setPieceId(e.target.value)}
              />
            </div>
            <div>
              <label className={label}>Composer</label>
              <input className={input} placeholder="Muzio Clementi" value={composer} onChange={(e) => setComposer(e.target.value)} />
            </div>
          </div>
          <div>
            <label className={label}>Title</label>
            <input className={input} placeholder="Sonatina Op. 36 No. 1" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className={label}>Subtitle (movement / number)</label>
            <input className={input} placeholder="I. Allegro" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={label}>Difficulty (1 beginner … 5 virtuoso)</label>
              <select className={input} value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
                <option value="">unrated</option>
                {[1, 2, 3, 4, 5].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Tracking quality</label>
              <select className={input} value={tracking} onChange={(e) => setTracking(e.target.value)}>
                <option value="experimental">experimental (Challenge shelf)</option>
                <option value="validated">validated (main Pieces shelf)</option>
              </select>
            </div>
          </div>
        </Card>

        <Card className="p-5 space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Book (optional)</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={label}>Method book / collection</label>
              <select className={input} value={bookId} onChange={(e) => setBookId(e.target.value)}>
                <option value="">none</option>
                {books.data?.items.map((b) => (
                  <option key={b.id} value={b.id}>{b.title}</option>
                ))}
                <option value="__new__">+ new book…</option>
              </select>
            </div>
            <div>
              <label className={label}>Index in book</label>
              <input className={input} type="number" placeholder="41" value={bookIndex} onChange={(e) => setBookIndex(e.target.value)} />
            </div>
          </div>
          {bookId === "__new__" && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={label}>New book ID (slug)</label>
                <input className={`${input} font-mono`} placeholder="czerny_op599" value={newBookId} onChange={(e) => setNewBookId(e.target.value)} />
              </div>
              <div>
                <label className={label}>New book title</label>
                <input className={input} placeholder="Practical Method, Op. 599" value={newBookTitle} onChange={(e) => setNewBookTitle(e.target.value)} />
              </div>
            </div>
          )}
        </Card>

        <Card className="p-5 space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Rights</p>
          <div>
            <label className={label}>Copyright status (publishing requires public domain or licensed)</label>
            <select className={input} value={rights} onChange={(e) => setRights(e.target.value)}>
              <option value="public_domain">public domain (self-engraved from a PD source)</option>
              <option value="licensed">licensed</option>
              <option value="unknown">unknown — needs review before publish</option>
            </select>
          </div>
          <div>
            <label className={label}>Provenance note (source edition, where the XML came from)</label>
            <textarea
              className={`${input} h-20 resize-none`}
              placeholder="Re-engraved from Peters 1900 print; no modern editorial layer."
              value={rightsNote}
              onChange={(e) => setRightsNote(e.target.value)}
            />
          </div>
        </Card>

        {create.isError && <ErrorNote message={create.error.message} />}
        <button
          className="rounded-lg bg-brand text-white text-sm font-medium px-5 py-2.5 hover:opacity-90 disabled:opacity-40"
          disabled={!canSubmit}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Uploading…" : "Upload & run gates"}
        </button>
      </div>
    </>
  );
}
