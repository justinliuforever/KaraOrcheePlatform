import type { ReactNode } from "react";
import { Badge } from "@/components/ui-kit/badge";

// Tone → Badge rendering for NON-state badges (user roles, instrument, "current").
// State tags (lifecycle / rights / shelf) render through StatusTag + the lib/tags
// registry instead — do not add state values here.
const TONE_VARIANT: Record<
  string,
  { variant: "default" | "secondary" | "destructive" | "outline"; className?: string }
> = {
  brand: { variant: "default" },
  bad: { variant: "destructive" },
  muted: { variant: "secondary" },
  ok: { variant: "outline", className: "border-emerald-200 bg-emerald-50 text-ok" },
  warn: { variant: "outline", className: "border-amber-200 bg-amber-50 text-warn" },
};

export default function ToneBadge({
  tone,
  className,
  children,
}: {
  tone: string;
  className?: string;
  children: ReactNode;
}) {
  const t = TONE_VARIANT[tone] ?? TONE_VARIANT.muted;
  return (
    <Badge variant={t.variant} className={`${t.className ?? ""} ${className ?? ""}`.trim() || undefined}>
      {children}
    </Badge>
  );
}
