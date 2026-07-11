import type { ReactNode } from "react";

export const inputCls =
  "w-full rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none focus:border-brand focus-visible:ring-[3px] focus-visible:ring-ring/30";

/** Shared column-header treatment for ui-kit TableHead across every table. */
export const thCls = "px-4 text-xs font-medium uppercase tracking-wide text-ink-faint";

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="text-sm text-ink-soft mt-0.5">{subtitle}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

export type Tone = "ok" | "warn" | "bad" | "muted" | "brand";

export function statusTone(status: string): Tone {
  switch (status) {
    case "published":
    case "active":
      return "ok";
    case "draft":
      return "warn";
    case "archived":
    case "deleted":
    case "blocked":
      return "bad";
    default:
      return "muted";
  }
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-soft py-10 justify-center">
      <div className="size-4 rounded-full border-2 border-line border-t-brand animate-spin" />
      {label}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 text-bad text-sm px-4 py-3">
      {message}
    </div>
  );
}
