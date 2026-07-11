import { useState } from "react";
import { fmtKB } from "./shared";

/** Styled file picker: label-wrapped hidden input (display:none would drop it from
 * the a11y tree), drag-drop, clear chosen-state. */
export default function FilePick({
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
