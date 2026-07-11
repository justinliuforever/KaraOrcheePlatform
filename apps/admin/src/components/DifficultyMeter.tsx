import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui-kit/tooltip";

const BAR_HEIGHTS = ["h-1.5", "h-2", "h-2.5", "h-3", "h-3.5"];

/** Five-bar difficulty meter (1–5) with numeral — compact enough for a table cell. */
export default function DifficultyMeter({
  value,
  className,
}: {
  value: number | null;
  className?: string;
}) {
  const level = value != null ? Math.min(5, Math.max(1, Math.round(value))) : 0;
  const hint = level > 0 ? `Difficulty ${level} of 5` : "Not yet rated";
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex items-center gap-1.5", className)} aria-label={hint}>
            <span className="flex items-end gap-[2px]" aria-hidden>
              {BAR_HEIGHTS.map((h, i) => (
                <span
                  key={i}
                  className={cn("w-1 rounded-[1px]", h, i < level ? "bg-brand" : "bg-line")}
                />
              ))}
            </span>
            <span className="w-3 text-right text-xs tabular-nums text-ink-soft">
              {level > 0 ? level : "—"}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent sideOffset={4}>{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
