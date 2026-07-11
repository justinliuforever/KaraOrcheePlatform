import type { CheckFinding } from "../../api";

export const labelCls = "block text-xs font-medium text-ink-soft mb-1.5";

export function fmtKB(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FindingRow({ f }: { f: CheckFinding }) {
  const tone =
    f.level === "error"
      ? "border-red-200 bg-red-50 text-bad"
      : f.level === "warn"
        ? "border-amber-200 bg-amber-50 text-warn"
        : "border-indigo-200 bg-brand-soft text-brand";
  return <p className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${tone}`}>{f.message}</p>;
}
