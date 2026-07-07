import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-card border border-line rounded-xl overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between mb-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-ink-soft mt-0.5">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <th className={`text-left text-xs font-medium uppercase tracking-wide text-ink-faint px-4 py-2.5 ${className}`}>
      {children}
    </th>
  );
}

export function Td({
  children,
  className = "",
  colSpan,
}: {
  children?: ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className={`px-4 py-3 text-sm border-t border-line ${className}`}>
      {children}
    </td>
  );
}

const badgeTones: Record<string, string> = {
  ok: "bg-emerald-50 text-ok border-emerald-200",
  warn: "bg-amber-50 text-warn border-amber-200",
  bad: "bg-red-50 text-bad border-red-200",
  muted: "bg-gray-50 text-ink-soft border-line",
  brand: "bg-brand-soft text-brand border-indigo-200",
};

export function Badge({ tone = "muted", children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badgeTones[tone]}`}>
      {children}
    </span>
  );
}

export function statusTone(status: string): keyof typeof badgeTones {
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

export function rightsTone(rights: string): keyof typeof badgeTones {
  switch (rights) {
    case "public_domain":
    case "licensed":
      return "ok";
    case "unknown":
      return "warn";
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
