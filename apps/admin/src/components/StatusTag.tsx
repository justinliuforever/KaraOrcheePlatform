import { cn } from "@/lib/utils";
import { resolveTag, type TagFamily } from "@/lib/tags";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui-kit/tooltip";

/** Registry-driven state tag. `family` is only needed when the value is ambiguous;
 * `label` overrides display text (e.g. composite job labels like "draft · checking")
 * without changing which registry entry styles the tag. `onClick` renders a button
 * and appends "Click to filter" to the tooltip. */
export default function StatusTag({
  value,
  family,
  label,
  className,
  onClick,
}: {
  value: string;
  family?: TagFamily;
  label?: string;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const spec = resolveTag(value, family);
  const text = label ?? spec?.label ?? value.replace(/_/g, " ");
  const Tag = onClick ? "button" : "span";
  const tag = (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        spec?.pill ?? "border-transparent bg-gray-100 text-ink-soft",
        onClick &&
          "cursor-pointer focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
    >
      {spec?.dot && (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", spec.dot, spec.dotPulse && "animate-pulse")}
        />
      )}
      {text}
    </Tag>
  );
  if (!spec) return tag;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{tag}</TooltipTrigger>
        <TooltipContent sideOffset={4} className="max-w-64">
          {spec.description}
          {onClick && <span className="mt-0.5 block opacity-70">Click to filter</span>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
