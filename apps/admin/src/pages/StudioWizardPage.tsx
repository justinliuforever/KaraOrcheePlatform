import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  apiForm,
  type AdminBook,
  type CheckFinding,
  type StudioJob,
  type StudioMetadata,
} from "../api";
import { Badge, Card, ErrorNote, Spinner } from "../components/ui";
import { PREFLIGHT_GATES, RENDER_GATE, failureHint } from "../studio/gateInfo";

const inputCls =
  "w-full rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none focus:border-brand";
const labelCls = "block text-xs font-medium text-ink-soft mb-1.5";
const btnPrimary =
  "rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 hover:opacity-90 disabled:opacity-40";
const btnGhost =
  "rounded-lg border border-line text-sm font-medium px-4 py-2 hover:bg-paper disabled:opacity-40";

function fmtKB(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Styled file picker: label-wrapped hidden input (display:none would drop it from
 * the a11y tree), drag-drop, clear chosen-state. */
function FilePick({
  label,
  accept,
  hint,
  file,
  onFile,
}: {
  label: string;
  accept: string;
  hint: string;
  file: File | null;
  onFile: (f: File | null) => void;
}) {
  const [drag, setDrag] = useState(false);
  return (
    <label
      className={`block rounded-xl border-2 border-dashed px-4 py-5 cursor-pointer transition-colors
        ${drag ? "border-brand bg-brand-soft" : file ? "border-emerald-300 bg-emerald-50/40" : "border-line bg-card hover:border-brand/50"}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <input
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{label}</p>
          {file ? (
            <p className="text-xs text-ok mt-0.5">
              {file.name} · {fmtKB(file.size)}
            </p>
          ) : (
            <p className="text-xs text-ink-faint mt-0.5">{hint}</p>
          )}
        </div>
        <span className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium border ${file ? "border-emerald-300 text-ok" : "border-line text-ink-soft"}`}>
          {file ? "Replace" : "Choose file"}
        </span>
      </div>
    </label>
  );
}

function FindingRow({ f }: { f: CheckFinding }) {
  const tone =
    f.level === "error"
      ? "border-red-200 bg-red-50 text-bad"
      : f.level === "warn"
        ? "border-amber-200 bg-amber-50 text-warn"
        : "border-indigo-200 bg-brand-soft text-brand";
  return <p className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${tone}`}>{f.message}</p>;
}

/** Live check rail: GitHub-Actions-style step list fed by the polled job row. */
function CheckRail({ job }: { job: StudioJob }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Automated checks
      </p>
      {PREFLIGHT_GATES.map((g) => {
        const entry = job.gates?.[g.key];
        const icon =
          entry?.status === "pass" ? (
            <span className="text-ok">✓</span>
          ) : entry?.status === "fail" ? (
            <span className="text-bad">✗</span>
          ) : entry?.status === "running" ? (
            <span className="inline-block size-3 rounded-full border-2 border-line border-t-brand animate-spin" />
          ) : (
            <span className="text-ink-faint">·</span>
          );
        const m = entry?.metrics ?? {};
        return (
          <div key={g.key} className="rounded-xl border border-line bg-card px-3.5 py-3">
            <button
              className="w-full flex items-start justify-between gap-2 text-left"
              onClick={() => setOpen(open === g.key ? null : g.key)}
            >
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  {icon} {g.label}
                </p>
                <p className="text-[11px] text-ink-faint mt-0.5">{g.blurb}</p>
              </div>
              <span className="text-ink-faint text-xs mt-0.5">{open === g.key ? "−" : "?"}</span>
            </button>
            {g.key === "sanity" && entry?.status === "pass" && (
              <p className="text-[11px] text-ink-soft mt-1.5 tabular-nums">
                {String(m.measures)} measures · {String(m.xml_onsets)} score notes ·{" "}
                {String(m.midi_notes)} MIDI notes · {String(m.midi_duration_sec)}s
              </p>
            )}
            {g.key === "geometry" && entry?.status === "pass" && (
              <p className="text-[11px] text-ink-soft mt-1.5 tabular-nums">
                {String(m.systems)} systems · timeline offset {String(m.residual_p50_ms)}ms (median)
              </p>
            )}
            {open === g.key && (
              <ul className="mt-2 space-y-1">
                {g.explain.map((line, i) => (
                  <li key={i} className="text-[11px] text-ink-soft leading-relaxed">
                    · {line}
                  </li>
                ))}
              </ul>
            )}
            {entry?.status === "fail" && (
              <div className="mt-2 space-y-1.5">
                <p className="text-[11px] text-bad leading-relaxed">{entry.error}</p>
                <p className="text-[11px] text-ink leading-relaxed rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2">
                  💡 {failureHint(g.key, entry.error ?? "")}
                </p>
              </div>
            )}
          </div>
        );
      })}
      <div className="rounded-xl border border-dashed border-line px-3.5 py-3">
        <p className="text-sm font-medium text-ink-faint">{RENDER_GATE.label}</p>
        <p className="text-[11px] text-ink-faint mt-0.5">Runs after you submit (~20s).</p>
      </div>
    </div>
  );
}

/** Client-side cover pre-validation before any bytes leave the browser. */
function validateCoverFile(f: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const aspect = h / w;
      if (aspect < 1.2 || aspect > 1.5) {
        resolve(`Image is ${w}×${h} — covers must be portrait, close to 3:4 (e.g. 1200×1600).`);
      } else if (w < 1200 || h < 1600) {
        resolve(`Image is ${w}×${h}px — needs at least 1200×1600px to stay sharp in the app.`);
      } else {
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve("The image couldn't be read. Use a JPEG, PNG, or WebP file.");
    };
    img.src = url;
  });
}

export default function StudioWizardPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <WizardBody jobId={id} /> : <FilesGate />;
}

function FilesGate() {
  const nav = useNavigate();
  const [musicxml, setMusicxml] = useState<File | null>(null);
  const [midi, setMidi] = useState<File | null>(null);

  const create = useMutation<StudioJob, Error>({
    mutationFn: () => {
      const form = new FormData();
      form.set("musicxml", musicxml!);
      form.set("midi", midi!);
      return apiForm<StudioJob>("/admin/studio/drafts", form);
    },
    onSuccess: (job) => nav(`/studio/${job.id}/edit`, { replace: true }),
  });

  return (
    <>
      <div className="mb-4">
        <Link to="/studio" className="text-sm text-brand hover:underline">
          ← Studio
        </Link>
      </div>
      <div className="max-w-xl">
        <h1 className="text-xl font-semibold tracking-tight mb-1">New piece</h1>
        <p className="text-sm text-ink-soft mb-6">
          Export <strong>both files from the same project</strong> in your notation software
          (MuseScore / Sibelius / Finale / Dorico). The checks start the moment you upload — you fill
          in the rest while they run.
        </p>
        <div className="space-y-3">
          <FilePick
            label="MusicXML — the score"
            accept=".musicxml,.xml,.mxl"
            hint="File → Export → MusicXML (.musicxml or .mxl)"
            file={musicxml}
            onFile={setMusicxml}
          />
          <FilePick
            label="MIDI — the timeline"
            accept=".mid,.midi"
            hint="File → Export → MIDI (.mid) · turn OFF humanize/swing playback"
            file={midi}
            onFile={setMidi}
          />
        </div>
        {create.isError && (
          <div className="mt-3">
            <ErrorNote message={create.error.message} />
          </div>
        )}
        <button
          className={`${btnPrimary} mt-4 px-6 py-2.5`}
          disabled={!musicxml || !midi || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Uploading…" : "Upload & start checks"}
        </button>
      </div>
    </>
  );
}

function WizardBody({ jobId }: { jobId: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();

  const jobQ = useQuery<StudioJob, Error>({
    queryKey: ["studio-job", jobId],
    queryFn: () => api(`/admin/studio/jobs/${jobId}`),
    refetchInterval: (q) => {
      const j = q.state.data;
      if (!j) return 1500;
      return j.checkStatus === "pending" || j.checkStatus === "running" ? 1500 : false;
    },
  });

  const booksQ = useQuery<{ items: AdminBook[] }, Error>({
    queryKey: ["books"],
    queryFn: () => api("/admin/books"),
  });

  // Form state seeds once from the server draft, then autosaves on blur.
  const [meta, setMeta] = useState<StudioMetadata>({});
  const seeded = useRef(false);
  useEffect(() => {
    if (jobQ.data && !seeded.current) {
      seeded.current = true;
      setMeta(jobQ.data.metadata ?? {});
    }
  }, [jobQ.data]);

  const [pieceFindings, setPieceFindings] = useState<CheckFinding[]>([]);
  const [bookFindings, setBookFindings] = useState<CheckFinding[]>([]);
  const [derivedSlug, setDerivedSlug] = useState<string | null>(null);

  const save = useMutation<StudioJob, Error, Partial<StudioMetadata>>({
    mutationFn: (patch) =>
      api(`/admin/studio/jobs/${jobId}/metadata`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (job) => qc.setQueryData(["studio-job", jobId], (old: StudioJob | undefined) =>
      old ? { ...old, metadata: job.metadata, pieceId: job.pieceId } : job,
    ),
  });

  async function runPieceChecks(m: StudioMetadata) {
    if (!m.title || !m.composer) return;
    const res = await api<{ pieceId: string | null; findings: CheckFinding[] }>(
      "/admin/studio/checks",
      { method: "POST", body: JSON.stringify({ title: m.title, composer: m.composer, subtitle: m.subtitle ?? "" }) },
    );
    setDerivedSlug(res.pieceId);
    setPieceFindings(res.findings);
  }

  async function runBookChecks(m: StudioMetadata) {
    if (!m.book) {
      setBookFindings([]);
      return;
    }
    const res = await api<{ findings: CheckFinding[] }>("/admin/studio/checks", {
      method: "POST",
      body: JSON.stringify({
        title: m.title,
        composer: m.composer,
        subtitle: m.subtitle ?? "",
        book: { id: m.book.id, index: m.book.index },
      }),
    });
    setBookFindings(res.findings);
  }

  function saveField(patch: Partial<StudioMetadata>, opts: { pieceChecks?: boolean; bookChecks?: boolean } = {}) {
    const next = { ...meta, ...patch };
    setMeta(next);
    save.mutate(patch);
    if (opts.pieceChecks) void runPieceChecks(next);
    if (opts.bookChecks) void runBookChecks(next);
  }

  // Replace-files affordance (lives in section 1).
  const [newXml, setNewXml] = useState<File | null>(null);
  const [newMidi, setNewMidi] = useState<File | null>(null);
  const replace = useMutation<StudioJob, Error>({
    mutationFn: () => {
      const form = new FormData();
      form.set("musicxml", newXml!);
      form.set("midi", newMidi!);
      return apiForm<StudioJob>(`/admin/studio/jobs/${jobId}/files`, form, "PUT");
    },
    onSuccess: () => {
      setNewXml(null);
      setNewMidi(null);
      qc.invalidateQueries({ queryKey: ["studio-job", jobId] });
    },
  });

  const submit = useMutation<StudioJob, Error>({
    mutationFn: () => api(`/admin/studio/jobs/${jobId}/submit`, { method: "POST" }),
    onSuccess: (res) => {
      // Write the queued row into the cache BEFORE navigating — the detail page must
      // never see the stale draft snapshot the wizard was just polling.
      qc.setQueryData(["studio-job", jobId], (old: StudioJob | undefined) =>
        old ? { ...old, ...res } : res,
      );
      qc.invalidateQueries({ queryKey: ["studio-jobs"] });
      nav(`/studio/${jobId}`);
    },
  });

  const cancel = useMutation<StudioJob, Error>({
    mutationFn: () => api(`/admin/studio/jobs/${jobId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["studio-jobs"] });
      nav("/studio");
    },
  });

  if (jobQ.isPending) return <Spinner />;
  if (jobQ.isError) return <ErrorNote message={jobQ.error.message} />;
  const job = jobQ.data;
  if (job.status !== "draft") {
    return (
      <div className="py-10 text-center">
        <p className="text-sm text-ink-soft mb-3">This build has already been submitted.</p>
        <Link className="text-brand text-sm font-medium hover:underline" to={`/studio/${jobId}`}>
          Open its status page →
        </Link>
      </div>
    );
  }

  const checksPassed = job.checkStatus === "pass";
  const hasErrors =
    pieceFindings.some((f) => f.level === "error") || bookFindings.some((f) => f.level === "error");
  const metaComplete =
    !!meta.title?.trim() &&
    !!meta.composer?.trim() &&
    !!meta.rights &&
    (meta.rights !== "public_domain" || !!meta.rightsNote?.trim());
  // save.isPending guard: a blur-save fired by the submit click itself must land
  // before the server validates the row.
  const canSubmit = checksPassed && metaComplete && !hasErrors && !submit.isPending && !save.isPending;
  const phonePreview = job.previews?.find((p) => p.role === "svg" && p.variant === "phone");

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <Link to="/studio" className="text-sm text-brand hover:underline">
          ← Studio
        </Link>
        <button className="text-xs text-ink-faint hover:text-bad" onClick={() => cancel.mutate()}>
          Discard draft
        </button>
      </div>

      <div className="grid grid-cols-[1fr_310px] gap-6 items-start max-w-5xl">
        {/* ——— left: the form ——— */}
        <div className="space-y-4 min-w-0">
          <Card className="p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">1 · Files</p>
              <Badge tone={checksPassed ? "ok" : job.checkStatus === "fail" ? "bad" : "warn"}>
                {checksPassed ? "checks passed" : job.checkStatus === "fail" ? "checks failed" : "checking…"}
              </Badge>
            </div>
            {job.sources.map((s) => (
              <p key={s.path} className="text-xs font-mono text-ink-soft py-0.5">
                {s.kind}: {s.originalName} · {fmtKB(s.bytes)}
              </p>
            ))}
            {job.checkStatus === "fail" && (
              <div className="mt-3 space-y-3">
                <FilePick
                  label="Fixed MusicXML"
                  accept=".musicxml,.xml,.mxl"
                  hint="Re-export and drop the corrected file here"
                  file={newXml}
                  onFile={setNewXml}
                />
                <FilePick
                  label="Fixed MIDI"
                  accept=".mid,.midi"
                  hint="Re-export with humanize/swing OFF"
                  file={newMidi}
                  onFile={setNewMidi}
                />
                <button
                  className={btnPrimary}
                  disabled={!newXml || !newMidi || replace.isPending}
                  onClick={() => replace.mutate()}
                >
                  {replace.isPending ? "Uploading…" : "Replace files & re-check"}
                </button>
                {replace.isError && <ErrorNote message={replace.error.message} />}
              </div>
            )}
          </Card>

          <Card className="p-5 space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">2 · Piece info</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Composer</label>
                <input
                  className={inputCls}
                  placeholder="Muzio Clementi"
                  value={meta.composer ?? ""}
                  onChange={(e) => setMeta({ ...meta, composer: e.target.value })}
                  onBlur={(e) => saveField({ composer: e.target.value }, { pieceChecks: true })}
                />
              </div>
              <div>
                <label className={labelCls}>Difficulty (1 beginner … 5 virtuoso)</label>
                <select
                  className={inputCls}
                  value={meta.difficulty ?? ""}
                  onChange={(e) =>
                    saveField({ difficulty: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  <option value="">unrated</option>
                  {[1, 2, 3, 4, 5].map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>Title</label>
              <input
                className={inputCls}
                placeholder="Sonatina Op. 36 No. 1"
                value={meta.title ?? ""}
                onChange={(e) => setMeta({ ...meta, title: e.target.value })}
                onBlur={(e) => saveField({ title: e.target.value }, { pieceChecks: true })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Subtitle (movement / number)</label>
                <input
                  className={inputCls}
                  placeholder="I. Allegro"
                  value={meta.subtitle ?? ""}
                  onChange={(e) => setMeta({ ...meta, subtitle: e.target.value })}
                  onBlur={(e) => saveField({ subtitle: e.target.value }, { pieceChecks: true })}
                />
              </div>
              <div>
                <label className={labelCls}>Shelf</label>
                <select
                  className={inputCls}
                  value={meta.tracking ?? "experimental"}
                  onChange={(e) =>
                    saveField({ tracking: e.target.value as "validated" | "experimental" })
                  }
                >
                  <option value="experimental">Challenge (experimental tracking)</option>
                  <option value="validated">Pieces (validated tracking)</option>
                </select>
              </div>
            </div>
            {(derivedSlug ?? (job.pieceId.startsWith("draft_") ? null : job.pieceId)) && (
              <p className="text-[11px] text-ink-faint">
                Piece ID (automatic):{" "}
                <span className="font-mono text-ink-soft">
                  {derivedSlug ?? job.pieceId}
                </span>
              </p>
            )}
            {pieceFindings.map((f, i) => (
              <FindingRow key={i} f={f} />
            ))}
          </Card>

          <BookSection
            meta={meta}
            books={booksQ.data?.items ?? []}
            findings={bookFindings}
            onChange={(book) => saveField({ book }, { bookChecks: true })}
            onBooksChanged={() => qc.invalidateQueries({ queryKey: ["books"] })}
          />

          <Card className="p-5 space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              4 · Rights <span className="text-bad">*</span>
            </p>
            <div className="space-y-2">
              {(
                [
                  ["public_domain", "Public domain", "Self-engraved from a pre-1930 source; no modern editorial layer"],
                  ["licensed", "Licensed", "We hold a license for this edition"],
                  ["unknown", "Unknown — needs review", "Can be built and previewed, but NOT published until resolved"],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className={`flex items-start gap-3 rounded-lg border px-3.5 py-2.5 cursor-pointer
                    ${meta.rights === value ? "border-brand bg-brand-soft" : "border-line bg-card hover:border-brand/40"}`}
                >
                  <input
                    type="radio"
                    name="rights"
                    className="mt-0.5"
                    checked={meta.rights === value}
                    onChange={() => saveField({ rights: value })}
                  />
                  <span>
                    <span className="text-sm font-medium block">{label}</span>
                    <span className="text-[11px] text-ink-faint">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <div>
              <label className={labelCls}>
                Provenance note{meta.rights === "public_domain" && <span className="text-bad"> * (required for public domain)</span>}
              </label>
              <textarea
                className={`${inputCls} h-20 resize-none`}
                placeholder="Re-engraved from the Peters 1900 print; no modern editorial layer."
                value={meta.rightsNote ?? ""}
                onChange={(e) => setMeta({ ...meta, rightsNote: e.target.value })}
                onBlur={(e) => saveField({ rightsNote: e.target.value })}
              />
            </div>
          </Card>

          <Card className="p-5 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">5 · Review & submit</p>
            {checksPassed && phonePreview && (
              <details className="rounded-lg border border-line overflow-hidden">
                <summary className="px-3.5 py-2.5 text-sm font-medium cursor-pointer bg-paper/50">
                  Engraving preview (phone) — click to expand
                </summary>
                <div className="max-h-130 overflow-y-auto bg-white">
                  <img src={phonePreview.url} alt="engraving preview" className="w-full" />
                </div>
              </details>
            )}
            <ul className="text-xs text-ink-soft space-y-1">
              <li>{checksPassed ? "✓" : "○"} Automated checks passed</li>
              <li>{meta.title?.trim() && meta.composer?.trim() ? "✓" : "○"} Title & composer</li>
              <li>{meta.rights ? "✓" : "○"} Rights declared{meta.rights === "public_domain" && !meta.rightsNote?.trim() ? " (provenance note missing)" : ""}</li>
              <li>{!hasErrors ? "✓" : "✗"} No blocking conflicts</li>
            </ul>
            <p className="text-[11px] text-ink-faint leading-relaxed">
              Submitting runs every check again from scratch — including the on-screen render
              verification (~20s) — then waits for your review before anything publishes.
            </p>
            {submit.isError && <ErrorNote message={submit.error.message} />}
            <button className={`${btnPrimary} px-6 py-2.5`} disabled={!canSubmit} onClick={() => submit.mutate()}>
              {submit.isPending ? "Submitting…" : "Submit for full verification"}
            </button>
          </Card>
        </div>

        {/* ——— right: live checks rail ——— */}
        <div className="sticky top-4">
          <CheckRail job={job} />
        </div>
      </div>
    </>
  );
}

function BookSection({
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
      onChange({ id: book.id, index: meta.book?.index ?? null });
    },
  });

  return (
    <Card className="p-5 space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">3 · Book (optional)</p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Method book / collection</label>
          <select
            className={inputCls}
            value={creating ? "__new__" : (meta.book?.id ?? "")}
            onChange={(e) => {
              if (e.target.value === "__new__") {
                setCreating(true);
              } else {
                setCreating(false);
                onChange(e.target.value ? { id: e.target.value, index: meta.book?.index ?? null } : null);
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
          <label className={labelCls}>Number in book</label>
          <input
            className={inputCls}
            type="number"
            placeholder="41"
            value={meta.book?.index ?? ""}
            disabled={!meta.book && !creating}
            onChange={(e) => {
              if (meta.book) {
                onChange({ ...meta.book, index: e.target.value ? Number(e.target.value) : null });
              }
            }}
          />
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
              {!selected.coverThumbUrl && " · cover missing — upload one from the Pieces page"}
            </p>
          </div>
        </div>
      )}

      {creating && (
        <div className="rounded-lg border border-line bg-paper/40 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Book title</label>
              <input className={inputCls} placeholder="Practical Method, Op. 599" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Author (optional)</label>
              <input className={inputCls} placeholder="Carl Czerny" value={newAuthor} onChange={(e) => setNewAuthor(e.target.value)} />
            </div>
          </div>
          <div>
            <label className={labelCls}>
              Cover image <span className="text-bad">*</span> — portrait 3:4, at least 1200×1600, JPEG/PNG/WebP
            </label>
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
            <button
              className={btnPrimary}
              disabled={!newTitle.trim() || !cover || createBook.isPending}
              onClick={() => createBook.mutate()}
            >
              {createBook.isPending ? "Creating…" : "Create book"}
            </button>
            <button className={btnGhost} onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {findings.map((f, i) => (
        <FindingRow key={i} f={f} />
      ))}
    </Card>
  );
}
