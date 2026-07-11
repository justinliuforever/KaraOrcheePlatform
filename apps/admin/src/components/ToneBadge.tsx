import type { ReactNode } from "react";
import { Badge } from "@/components/ui-kit/badge";

// Single tone → Badge rendering for the whole console. The tone MAPPINGS
// (statusTone / rightsTone / jobTone) live with their domains; this only decides
// how a tone looks, so every status/rights badge is the same size and shape.
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
