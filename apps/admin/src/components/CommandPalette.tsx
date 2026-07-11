import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { BookCopy, Hammer, Library, ListMusic, Plus, Users } from "lucide-react";
import { api, type AdminPiece, type StudioJob } from "../api";
import { statusLabel } from "../studio/gateInfo";
import StatusTag from "./StatusTag";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui-kit/command";

export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Global ⌘K palette. Read-only and purely additive: it reuses the app-wide
 * ["pieces"] / ["studio-jobs"] caches (same endpoints the pages hit) and only
 * navigates — no mutations, no new data flow. Queries run when first opened. */
export default function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const nav = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const pieces = useQuery<{ items: AdminPiece[] }, Error>({
    queryKey: ["pieces"],
    queryFn: () => api("/admin/pieces"),
    enabled: open,
  });
  const jobs = useQuery<{ items: StudioJob[] }, Error>({
    queryKey: ["studio-jobs"],
    queryFn: () => api("/admin/studio/jobs"),
    enabled: open,
  });

  const go = (to: string) => {
    onOpenChange(false);
    nav(to);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command menu"
      description="Jump to a page, piece, or studio build"
      showCloseButton={false}
      className="top-[18%] translate-y-0 sm:max-w-xl"
    >
      <CommandInput placeholder="Jump to a page, piece, or build…" />
      <CommandList className="max-h-[340px]">
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Navigate">
          <CommandItem value="nav-pieces-library" keywords={["pieces", "library", "catalog"]} onSelect={() => go("/pieces")}>
            <Library />
            Pieces Library
          </CommandItem>
          <CommandItem value="nav-pieces-studio" keywords={["studio", "builds", "board"]} onSelect={() => go("/studio")}>
            <Hammer />
            Pieces Studio
          </CommandItem>
          <CommandItem value="nav-collections" keywords={["collections", "books", "bookshelf", "covers"]} onSelect={() => go("/collections")}>
            <BookCopy />
            Collections
          </CommandItem>
          <CommandItem value="nav-collections-works" keywords={["works", "compositions", "catalogue", "merge"]} onSelect={() => go("/collections?tab=works")}>
            <ListMusic />
            Collections · Works
          </CommandItem>
          <CommandItem value="nav-users" keywords={["users", "accounts"]} onSelect={() => go("/users")}>
            <Users />
            Users
          </CommandItem>
          <CommandItem value="nav-new-piece" keywords={["new", "piece", "upload", "create"]} onSelect={() => go("/studio/new")}>
            <Plus />
            New piece
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Pieces">
          {pieces.isPending && open && (
            <div className="px-2 py-1.5 text-xs text-ink-faint">Loading pieces…</div>
          )}
          {pieces.data?.items.map((p) => (
            <CommandItem
              key={p.id}
              value={`piece-${p.id}`}
              keywords={[p.title, p.composer, p.id, p.subtitle ?? ""].filter(Boolean)}
              onSelect={() => go(`/pieces?sel=${p.id}`)}
            >
              <span className="min-w-0 flex-1 truncate">
                {p.title}
                <span className="text-ink-faint"> · {p.composer}</span>
              </span>
              <StatusTag value={p.status} family="lifecycle" className="ml-auto" />
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Studio builds">
          {jobs.isPending && open && (
            <div className="px-2 py-1.5 text-xs text-ink-faint">Loading builds…</div>
          )}
          {jobs.data?.items.map((j) => (
            <CommandItem
              key={j.id}
              value={`job-${j.id}`}
              keywords={[j.metadata?.title ?? "", j.metadata?.composer ?? "", j.pieceId, j.status].filter(Boolean)}
              // Drafts open in the wizard, mirroring the board's row behavior.
              onSelect={() => go(j.status === "draft" ? `/studio/${j.id}/edit` : `/studio/${j.id}`)}
            >
              <span className="min-w-0 flex-1 truncate">
                {j.metadata?.title || <span className="text-ink-faint italic">untitled draft</span>}
                {!j.pieceId.startsWith("draft_") && (
                  <span className="text-ink-faint font-mono text-xs"> · {j.pieceId}</span>
                )}
              </span>
              <StatusTag value={j.status} family="lifecycle" label={statusLabel(j)} className="ml-auto" />
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      <div className="flex items-center gap-4 border-t border-line px-3 py-2 text-[11px] text-ink-faint">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        <span>esc close</span>
      </div>
    </CommandDialog>
  );
}
