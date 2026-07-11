import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiForm, type StudioJob, type StudioMetadata } from "../../api";
import { ErrorNote, inputCls } from "../../components/ui";
import { Button } from "@/components/ui-kit/button";
import { Label } from "@/components/ui-kit/label";
import FilePick from "./FilePick";
import { labelCls } from "./shared";

export default function FilesGate() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  // ?piece=<id> = "upload new version": the draft is pinned server-side to that piece's
  // permanent id and prefilled with its current metadata.
  const forPiece = params.get("piece");
  const [musicxml, setMusicxml] = useState<File | null>(null);
  const [midi, setMidi] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [instrument, setInstrument] = useState<NonNullable<StudioMetadata["instrument"]>>("piano");

  const create = useMutation<StudioJob, Error>({
    mutationFn: () => {
      const form = new FormData();
      form.set("musicxml", musicxml!);
      form.set("midi", midi!);
      if (audio) form.set("audio", audio);
      if (!forPiece) form.set("instrument", instrument);
      return apiForm<StudioJob>(
        `/admin/studio/drafts${forPiece ? `?piece=${encodeURIComponent(forPiece)}` : ""}`,
        form,
      );
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
        <h1 className="text-xl font-semibold tracking-tight mb-1">
          {forPiece ? "New version" : "New piece"}
        </h1>
        {forPiece && (
          <p className="text-xs rounded-lg border border-indigo-200 bg-brand-soft text-brand px-3 py-2 mb-3">
            Uploading new score files for <span className="font-mono">{forPiece}</span> — metadata
            carries over, and publishing creates its next version.
          </p>
        )}
        <p className="text-sm text-ink-soft mb-6">
          Export <strong>both files from the same project</strong> in your notation software
          (MuseScore / Sibelius / Finale / Dorico). The checks start the moment you upload — you fill
          in the rest while they run.
        </p>
        <div className="space-y-3">
          {!forPiece && (
            <div className="rounded-xl border border-line bg-card px-4 py-3.5">
              <Label className={labelCls}>Instrument (solo) — pick this first</Label>
              <select
                className={`${inputCls} max-w-56`}
                value={instrument}
                onChange={(e) => setInstrument(e.target.value as NonNullable<StudioMetadata["instrument"]>)}
              >
                <option value="piano">Piano</option>
                <option value="violin">Violin</option>
                <option value="guitar">Guitar</option>
              </select>
              <p className="text-[11px] text-ink-faint mt-1.5 leading-relaxed">
                The checks and the preview audio render with this instrument's sound, so it
                has to be right before the files go up. You can still change it later — the
                checks just re-run.
              </p>
            </div>
          )}
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
          <details className="rounded-xl border border-line bg-card">
            <summary className="px-4 py-3 text-sm font-medium cursor-pointer text-ink-soft">
              Reference audio (optional) — produced/polished recording
            </summary>
            <div className="px-4 pb-4 space-y-2">
              <p className="text-[11px] text-ink-soft leading-relaxed">
                Replaces the app's synthesized playback for this piece. <strong>Must be
                produced at the score's notated tempo</strong> (a studio render from the same
                MIDI/DAW project is exactly that). Why the strict check: tap-a-measure-to-seek,
                cursor sync, and start-anywhere all assume the audio matches the score timeline
                note-for-note — the automated verification guarantees a mismatched file can
                never silently break them.
              </p>
              <FilePick
                label="Audio (.m4a / .mp3 / .wav)"
                accept=".m4a,.mp3,.wav,.aac"
                hint="Optional — the app synthesizes playback when absent"
                file={audio}
                onFile={setAudio}
              />
            </div>
          </details>
        </div>
        {create.isError && (
          <div className="mt-3">
            <ErrorNote message={create.error.message} />
          </div>
        )}
        <Button
          size="lg"
          className="mt-4"
          disabled={!musicxml || !midi || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Uploading…" : "Upload & start checks"}
        </Button>
      </div>
    </>
  );
}
