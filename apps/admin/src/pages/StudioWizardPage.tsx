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
  type XmlMeta,
} from "../api";
import { ErrorNote, Spinner, inputCls } from "../components/ui";
import { Badge } from "@/components/ui-kit/badge";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import { Input } from "@/components/ui-kit/input";
import { Label } from "@/components/ui-kit/label";
import { Textarea } from "@/components/ui-kit/textarea";
import FilesGate from "../studio/wizard/FilesGate";
import CheckRail from "../studio/wizard/CheckRail";
import FactsCard from "../studio/wizard/FactsCard";
import PartPicker from "../studio/wizard/PartPicker";
import FilePick from "../studio/wizard/FilePick";
import WorkSection from "../studio/wizard/WorkSection";
import BookSection from "../studio/wizard/BookSection";
import { FindingRow, fmtKB, labelCls } from "../studio/wizard/shared";

const checkBadgeTone = {
  ok: "border-emerald-200 bg-emerald-50 text-ok",
  warn: "border-amber-200 bg-amber-50 text-warn",
  bad: "border-red-200 bg-red-50 text-bad",
} as const;

export default function StudioWizardPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <WizardBody jobId={id} /> : <FilesGate />;
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

  // XML suggestions prefill EMPTY fields once facts arrive (file values are suggestions,
  // never authoritative — always editable).
  const suggested = useRef(false);
  useEffect(() => {
    const xm = (jobQ.data?.gates?.sanity?.metrics as { xml_meta?: XmlMeta } | undefined)?.xml_meta;
    if (!xm || suggested.current || !seeded.current) return;
    suggested.current = true;
    setMeta((m) => {
      const patch: Partial<StudioMetadata> = {};
      if (!m.title && xm.suggested_title) patch.title = xm.suggested_title;
      if (!m.composer && xm.suggested_composer) patch.composer = xm.suggested_composer;
      if (!m.subtitle && xm.suggested_movement) patch.subtitle = xm.suggested_movement;
      if (Object.keys(patch).length > 0) save.mutate(patch); // prefill must PERSIST
      return { ...m, ...patch };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobQ.data]);

  const [pieceFindings, setPieceFindings] = useState<CheckFinding[]>([]);
  const [bookFindings, setBookFindings] = useState<CheckFinding[]>([]);
  const [workFindings, setWorkFindings] = useState<CheckFinding[]>([]);
  const [derivedSlug, setDerivedSlug] = useState<string | null>(null);

  const save = useMutation<StudioJob, Error, Partial<StudioMetadata>>({
    mutationFn: (patch) =>
      api(`/admin/studio/jobs/${jobId}/metadata`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (job) => qc.setQueryData(["studio-job", jobId], (old: StudioJob | undefined) =>
      // The PATCH response is the full row — checkStatus/gates/artifacts may have been
      // RESET server-side (instrument/soloPart change); writing them re-arms polling.
      old ? { ...old, ...job } : job,
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

  async function runWorkChecks(m: StudioMetadata) {
    if (!m.work) {
      setWorkFindings([]);
      return;
    }
    const res = await api<{ findings: CheckFinding[] }>("/admin/studio/checks", {
      method: "POST",
      body: JSON.stringify({
        composer: m.composer,
        instrument: m.instrument ?? "piano",
        work: { id: m.work.id, index: m.work.index },
      }),
    });
    setWorkFindings(res.findings);
  }

  function saveField(
    patch: Partial<StudioMetadata>,
    opts: { pieceChecks?: boolean; bookChecks?: boolean; workChecks?: boolean } = {},
  ) {
    const next = { ...meta, ...patch };
    setMeta(next);
    save.mutate(patch);
    if (opts.pieceChecks) void runPieceChecks(next);
    if (opts.bookChecks) void runBookChecks(next);
    if (opts.workChecks) void runWorkChecks(next);
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
    onSuccess: (job) => {
      qc.setQueryData(["studio-job", jobId], (old: StudioJob | undefined) => (old ? { ...old, ...job } : job));
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
  const xmlMeta = (job.gates?.sanity?.metrics as { xml_meta?: XmlMeta } | undefined)?.xml_meta;
  const stampedSolo = (job.gates?.sanity?.metrics as { solo_part?: string } | undefined)?.solo_part;
  const previewAudio = job.previews?.find((p) => p.role === "preview_audio");
  const referenceAudio = job.previews?.find((p) => p.role === "reference_audio");
  const audioTier = (job.gates?.audio?.metrics as { tier?: number } | undefined)?.tier;
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
        <div className="flex items-center gap-4">
          <span className="text-xs text-ink-faint" aria-live="polite">
            {save.isPending ? "Saving…" : save.isSuccess ? "All changes saved" : ""}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="text-ink-faint hover:text-bad"
            onClick={() => cancel.mutate()}
          >
            Discard draft
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_310px] gap-6 items-start max-w-5xl">
        {/* ——— left: the form ——— */}
        <div className="space-y-4 min-w-0">
          <Card className="block p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">1 · Files</p>
              <Badge
                variant="outline"
                className={
                  checksPassed
                    ? checkBadgeTone.ok
                    : job.checkStatus === "fail"
                      ? checkBadgeTone.bad
                      : checkBadgeTone.warn
                }
              >
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
                <Button
                  disabled={!newXml || !newMidi || replace.isPending}
                  onClick={() => replace.mutate()}
                >
                  {replace.isPending ? "Uploading…" : "Replace files & re-check"}
                </Button>
                {replace.isError && <ErrorNote message={replace.error.message} />}
              </div>
            )}
            {xmlMeta && (
              <div className="mt-3 space-y-3">
                <FactsCard meta={xmlMeta} />
                <PartPicker
                  meta={xmlMeta}
                  soloPart={meta.soloPart ?? stampedSolo ?? null}
                  onPick={(id) => saveField({ soloPart: id })}
                />
                {previewAudio && (
                  <div className="rounded-xl border border-line bg-card px-3.5 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-1.5">
                      Preview — how the app will sound
                    </p>
                    <audio controls preload="none" src={previewAudio.url} className="w-full h-9" />
                    <p className="text-[11px] text-ink-faint mt-1.5 leading-relaxed">
                      Synthesized with the app's own sound. Not good enough for this piece?
                      Add a produced reference audio in section 5.
                    </p>
                  </div>
                )}
                {referenceAudio && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 px-3.5 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-1.5">
                      Your uploaded recording — this is what ships in the app
                    </p>
                    <audio controls preload="none" src={referenceAudio.url} className="w-full h-9" />
                    <p className="text-[11px] text-ink-faint mt-1.5 leading-relaxed">
                      {audioTier === 2
                        ? "Verified as an expressive performance — the app will sync the cursor and tap-to-seek to it through its alignment map."
                        : audioTier === 1
                          ? "Verified at the notated tempo — full sync in the app."
                          : "Verification result appears in the checks on the right."}
                    </p>
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card className="block p-5 space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">2 · Piece info</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className={labelCls}>Composer</Label>
                <Input
                  placeholder="Muzio Clementi"
                  value={meta.composer ?? ""}
                  onChange={(e) => setMeta({ ...meta, composer: e.target.value })}
                  onBlur={(e) => saveField({ composer: e.target.value }, { pieceChecks: true })}
                />
              </div>
              <div>
                <Label className={labelCls}>Difficulty (1 beginner … 5 virtuoso)</Label>
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
              <Label className={labelCls}>Title</Label>
              <Input
                placeholder="Sonatina Op. 36 No. 1"
                value={meta.title ?? ""}
                onChange={(e) => setMeta({ ...meta, title: e.target.value })}
                onBlur={(e) => saveField({ title: e.target.value }, { pieceChecks: true })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className={labelCls}>Subtitle (movement / number)</Label>
                <Input
                  placeholder="I. Allegro"
                  value={meta.subtitle ?? ""}
                  onChange={(e) => setMeta({ ...meta, subtitle: e.target.value })}
                  onBlur={(e) => saveField({ subtitle: e.target.value }, { pieceChecks: true })}
                />
              </div>
              <div>
                <Label className={labelCls}>Shelf</Label>
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
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className={labelCls}>Instrument (solo)</Label>
                <select
                  className={inputCls}
                  value={meta.instrument ?? "piano"}
                  onChange={(e) =>
                    saveField({ instrument: e.target.value as StudioMetadata["instrument"] })
                  }
                >
                  <option value="piano">Piano</option>
                  <option value="violin">Violin</option>
                  <option value="guitar">Guitar</option>
                </select>
                <p className="text-[11px] text-ink-faint mt-1">
                  Changing this re-runs the checks (~10s) — the preview audio is rendered
                  with the instrument's sound.
                  {meta.instrument && meta.instrument !== "piano"
                    ? " Non-piano pieces stay hidden from the app until instrument-aware builds ship."
                    : ""}
                </p>
              </div>
            </div>
            {(job.metadata as { pinnedPieceId?: string }).pinnedPieceId ? (
              <p className="text-[11px] text-ink-faint">
                Piece ID (pinned — this upload becomes its next version):{" "}
                <span className="font-mono text-ink-soft">{job.pieceId}</span>
              </p>
            ) : (derivedSlug ?? (job.pieceId.startsWith("draft_") ? null : job.pieceId)) && (
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

          <WorkSection
            meta={meta}
            onChange={(work) => saveField({ work }, { workChecks: true })}
            findings={workFindings}
          />

          <BookSection
            meta={meta}
            books={booksQ.data?.items ?? []}
            findings={bookFindings}
            onChange={(book) => saveField({ book }, { bookChecks: true })}
            onBooksChanged={() => qc.invalidateQueries({ queryKey: ["books"] })}
          />

          <Card className="block p-5 space-y-4">
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
              <Label className={labelCls}>
                Provenance note{meta.rights === "public_domain" && <span className="text-bad"> * (required for public domain)</span>}
              </Label>
              <Textarea
                className="h-20 resize-none"
                placeholder="Re-engraved from the Peters 1900 print; no modern editorial layer."
                value={meta.rightsNote ?? ""}
                onChange={(e) => setMeta({ ...meta, rightsNote: e.target.value })}
                onBlur={(e) => saveField({ rightsNote: e.target.value })}
              />
            </div>
          </Card>

          <Card className="block p-5 space-y-3">
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
            <Button size="lg" disabled={!canSubmit} onClick={() => submit.mutate()}>
              {submit.isPending ? "Submitting…" : "Submit for full verification"}
            </Button>
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
