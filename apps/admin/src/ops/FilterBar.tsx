import { useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui-kit/button";
import { Input } from "@/components/ui-kit/input";
import { Label } from "@/components/ui-kit/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui-kit/popover";
import {
  FILTER_KEYS,
  RANGE_PRESETS,
  isoToLocalInput,
  localInputToIso,
  resolveWindow,
  tzLabel,
  type FilterKey,
  type OpsState,
  type RangeKey,
} from "./opsState";

export default function FilterBar({
  state,
  onRemoveFilter,
  onText,
  onRange,
  onAbsolute,
  onRefresh,
  fetching,
  auto,
  onAutoChange,
  autoPaused,
}: {
  state: OpsState;
  onRemoveFilter: (key: FilterKey) => void;
  onText: (text: string) => void;
  onRange: (key: RangeKey) => void;
  onAbsolute: (fromIso: string, toIso: string) => void;
  onRefresh: () => void;
  fetching: boolean;
  auto: boolean;
  onAutoChange: (on: boolean) => void;
  /** Auto-refresh is suspended while the detail drawer is open. */
  autoPaused: boolean;
}) {
  const live = state.range != null;
  const urlText = state.filters.text ?? "";
  const [textDraft, setTextDraft] = useState(urlText);
  // Distinguish our own debounced push (echoed back via the URL) from an external
  // change (saved view, tab switch) — only the latter may overwrite mid-typing input.
  const pushed = useRef(urlText);
  useEffect(() => {
    if (urlText !== pushed.current) {
      pushed.current = urlText;
      setTextDraft(urlText);
    }
  }, [urlText]);
  useEffect(() => {
    if (textDraft === urlText) return;
    const t = setTimeout(() => {
      pushed.current = textDraft;
      onText(textDraft);
    }, 400);
    return () => clearTimeout(t);
  }, [textDraft, urlText, onText]);

  const chips = FILTER_KEYS.filter((k) => k !== "text" && state.filters[k]);

  return (
    <div className="mb-4 rounded-xl border border-line bg-card px-3 py-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          className="flex-1 w-auto min-w-52 rounded-lg bg-paper/60 border-transparent text-sm"
          placeholder="Filter by text…"
          value={textDraft}
          onChange={(e) => setTextDraft(e.target.value)}
        />
        <div className="flex items-center rounded-lg border border-line overflow-hidden">
          {RANGE_PRESETS.map((r) => (
            <button
              key={r.key}
              className={cn(
                "px-2.5 py-1.5 text-xs font-medium border-r border-line last:border-r-0 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:z-10 relative",
                live && state.range === r.key
                  ? "bg-brand-soft text-brand"
                  : "text-ink-soft hover:bg-paper",
              )}
              onClick={() => onRange(r.key)}
            >
              {r.key}
            </button>
          ))}
          <CustomRange state={state} onAbsolute={onAbsolute} activeFrozen={!live} />
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px] font-medium",
            live ? "border-emerald-300 text-ok" : "border-line bg-paper text-ink-soft",
          )}
          title={
            live
              ? "Relative range — every refresh recomputes the window from now"
              : "Absolute range — the window is pinned; refresh re-runs the same query"
          }
        >
          {live ? "Live" : "Frozen"}
        </span>
        <span className="text-[11px] text-ink-faint tabular-nums">{tzLabel()}</span>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={fetching}>
          <RefreshCw className={cn(fetching && "animate-spin")} />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={auto}
          className={cn(auto && "border-brand/40 bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand")}
          title={
            auto && autoPaused
              ? "Auto-refresh is paused while the detail drawer is open"
              : "Refetch every 10 seconds"
          }
          onClick={() => onAutoChange(!auto)}
        >
          {auto ? (autoPaused ? "Auto · paused" : "Auto 10s") : "Auto off"}
        </Button>
      </div>
      {chips.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {chips.map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand-soft pl-2 pr-1 py-0.5 text-xs text-brand"
            >
              <span className="text-brand/70">{k}:</span>
              <span className="font-medium max-w-64 truncate" title={state.filters[k]}>
                {state.filters[k]}
              </span>
              <button
                className="rounded-full p-0.5 hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label={`Remove ${k} filter`}
                onClick={() => onRemoveFilter(k)}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomRange({
  state,
  onAbsolute,
  activeFrozen,
}: {
  state: OpsState;
  onAbsolute: (fromIso: string, toIso: string) => void;
  activeFrozen: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Seed the inputs from the current effective window each time the popover opens.
  useEffect(() => {
    if (!open) return;
    const w = resolveWindow(state);
    setFrom(isoToLocalInput(w.from));
    setTo(isoToLocalInput(w.to));
  }, [open, state]);

  const fromIso = localInputToIso(from);
  const toIso = localInputToIso(to);
  const valid = fromIso != null && toIso != null && fromIso < toIso;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:z-10 relative",
            activeFrozen ? "bg-brand-soft text-brand" : "text-ink-soft hover:bg-paper",
          )}
        >
          Custom
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="space-y-2.5">
          <div>
            <Label className="mb-1 text-xs">From ({tzLabel()})</Label>
            <input
              type="datetime-local"
              className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-brand focus-visible:ring-[3px] focus-visible:ring-ring/30"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <Label className="mb-1 text-xs">To ({tzLabel()})</Label>
            <input
              type="datetime-local"
              className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-brand focus-visible:ring-[3px] focus-visible:ring-ring/30"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-faint">Absolute ranges are frozen</span>
            <Button
              size="sm"
              disabled={!valid}
              onClick={() => {
                if (!valid) return;
                onAbsolute(fromIso, toIso);
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
