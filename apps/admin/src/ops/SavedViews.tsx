import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Bookmark, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { Input } from "@/components/ui-kit/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui-kit/popover";

const LS_KEY = "ops.savedViews";
const CAP = 20;

interface SavedView {
  name: string;
  qs: string;
}

function load(): SavedView[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is SavedView => typeof x?.name === "string" && typeof x?.qs === "string");
  } catch {
    return [];
  }
}

function store(views: SavedView[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(views));
}

/** Named bookmarks of the current URL query string — the whole investigation
 * (view, filters, time range) round-trips through it. */
export default function SavedViews() {
  const nav = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedView[]>(load);
  const [name, setName] = useState("");

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (views.length >= CAP) {
      toast.error(`Saved views are capped at ${CAP} — delete one first.`);
      return;
    }
    const qs = location.search.replace(/^\?/, "");
    const next = [{ name: trimmed, qs }, ...views.filter((v) => v.name !== trimmed)];
    setViews(next);
    store(next);
    setName("");
    toast(`"${trimmed}" saved`);
  };

  const remove = (target: SavedView) => {
    const next = views.filter((v) => v !== target);
    setViews(next);
    store(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Bookmark />
          Views
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <div className="flex items-center gap-1.5 p-1">
          <Input
            className="h-8 text-sm"
            placeholder="Save current view…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <Button size="sm" disabled={!name.trim()} onClick={save}>
            Save
          </Button>
        </div>
        {views.length === 0 && (
          <p className="px-2 py-3 text-xs text-ink-faint">
            No saved views yet — set up filters, then save them here by name.
          </p>
        )}
        {views.map((v) => (
          <div key={v.name} className="group flex items-center gap-1 rounded-lg hover:bg-paper">
            <button
              className="min-w-0 flex-1 px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-lg"
              onClick={() => {
                setOpen(false);
                nav(`/ops${v.qs ? `?${v.qs}` : ""}`);
              }}
            >
              <span className="block truncate text-sm">{v.name}</span>
              <span className="block truncate text-[11px] font-mono text-ink-faint">{v.qs || "(default)"}</span>
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="mr-1 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              aria-label={`Delete saved view ${v.name}`}
              onClick={() => remove(v)}
            >
              <X />
            </Button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
