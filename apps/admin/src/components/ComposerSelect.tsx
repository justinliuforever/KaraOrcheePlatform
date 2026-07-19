import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ApiError,
  createComposer,
  listComposers,
  type AdminComposer,
  type ComposersResponse,
} from "../api";
import { Input } from "@/components/ui-kit/input";
import ToneBadge from "./ToneBadge";

export function useComposerRegistry() {
  return useQuery<ComposersResponse, Error>({
    queryKey: ["composers"],
    queryFn: listComposers,
    staleTime: 60_000,
  });
}

/** Exact string match — the registry joins pieces by exact spelling (name or alias).
 * null = unknown (empty value, or registry not loaded yet). */
export function composerRegistered(
  data: ComposersResponse | undefined,
  value: string,
): boolean | null {
  if (!data) return null;
  const v = value.trim();
  if (!v) return null;
  return data.items.some((c) => c.name === v || c.aliases.includes(v));
}

// Mirrors the api's slugify enough to resolve a create-409 to its existing entry.
function slugApprox(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

type Option =
  | { kind: "entry"; entry: AdminComposer }
  | { kind: "alias"; alias: string; entry: AdminComposer }
  | { kind: "unregistered"; value: string; pieceCount: number }
  | { kind: "create"; name: string };

/** Search-and-select over the composer registry. The form value stays a plain
 * string (no FK — deliberate): selecting fills the canonical name, alias hits
 * resolve to it, and free text remains possible as an escape hatch. */
export default function ComposerSelect({
  value,
  onChange,
  onCommit,
  placeholder = "Muzio Clementi",
  showUnregisteredHint = true,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Blur / selection / creation — for hosts that autosave on commit. */
  onCommit?: (next: string) => void;
  placeholder?: string;
  showUnregisteredHint?: boolean;
}) {
  const qc = useQueryClient();
  const registry = useComposerRegistry();
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Blur can fire against a stale closure (a focused option unmounts on selection) —
  // the ref always holds the latest intended value, updated synchronously.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  const typed = value.trim();

  const options = useMemo<Option[]>(() => {
    const data = registry.data;
    if (!data) return [];
    const needle = typed.toLowerCase();
    const out: Option[] = [];
    if (needle === "") {
      for (const c of [...data.items].sort((a, b) => b.usageCount - a.usageCount).slice(0, 8)) {
        out.push({ kind: "entry", entry: c });
      }
      return out;
    }
    for (const c of data.items) {
      if (c.name.toLowerCase().includes(needle)) {
        out.push({ kind: "entry", entry: c });
      } else {
        const alias = c.aliases.find((a) => a.toLowerCase().includes(needle));
        if (alias) out.push({ kind: "alias", alias, entry: c });
      }
    }
    for (const u of data.unregistered) {
      if (u.value.toLowerCase().includes(needle)) {
        out.push({ kind: "unregistered", value: u.value, pieceCount: u.pieceCount });
      }
    }
    const capped = out.slice(0, 8);
    const exact = data.items.some((c) => c.name === typed || c.aliases.includes(typed));
    if (!exact) capped.push({ kind: "create", name: typed });
    return capped;
  }, [registry.data, typed]);

  function commit(next: string) {
    next = next.trim();
    latest.current = next;
    onChange(next);
    onCommit?.(next);
  }

  const create = useMutation<AdminComposer, Error, string>({
    mutationFn: (name) => createComposer({ name }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["composers"] });
      setCreated({ id: c.id, name: c.name });
      setOpen(false);
      setHi(-1);
      commit(c.name);
    },
    onError: async (e, name) => {
      if (e instanceof ApiError && e.status === 409) {
        // Entry already exists (same name or same derived id) — select it instead.
        const fresh = await qc.fetchQuery({
          queryKey: ["composers"],
          queryFn: listComposers,
          staleTime: 0,
        });
        const lower = name.toLowerCase();
        const hit =
          fresh.items.find((c) => c.name === name) ??
          fresh.items.find(
            (c) =>
              c.name.toLowerCase() === lower ||
              c.aliases.some((a) => a.toLowerCase() === lower),
          ) ??
          fresh.items.find((c) => c.id === slugApprox(name));
        if (hit) {
          setOpen(false);
          setHi(-1);
          commit(hit.name);
          return;
        }
      }
      setCreateErr(e.message);
    },
  });

  function pick(opt: Option) {
    setCreateErr(null);
    if (opt.kind === "create") {
      create.mutate(opt.name);
      return;
    }
    setCreated(null);
    setOpen(false);
    setHi(-1);
    commit(opt.kind === "unregistered" ? opt.value : opt.entry.name);
  }

  const registered = composerRegistered(registry.data, value);
  const showCreatedHint = created !== null && typed === created.name;

  return (
    <div
      ref={rootRef}
      onBlur={(e) => {
        if (rootRef.current?.contains(e.relatedTarget as Node)) return;
        setOpen(false);
        setHi(-1);
        onCommit?.(latest.current);
      }}
    >
      <Input
        placeholder={placeholder}
        value={value}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          latest.current = e.target.value;
          onChange(e.target.value);
          setOpen(true);
          setHi(-1);
          setCreateErr(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) setOpen(true);
            else setHi((h) => Math.min(h + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, -1));
          } else if (e.key === "Enter") {
            // No highlight = keep the typed string as-is (free-text escape hatch).
            e.preventDefault();
            if (open && hi >= 0 && options[hi]) pick(options[hi]);
            else {
              setOpen(false);
              commit(value);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
            setHi(-1);
          }
        }}
      />

      {/* In-flow like the works search list — host sections clip overflow, so no absolute overlay. */}
      {open && (
        <div className="mt-1 rounded-lg border border-line bg-card divide-y divide-line max-h-56 overflow-y-auto">
          {registry.isPending && (
            <p className="px-3 py-2 text-xs text-ink-faint">Loading registry…</p>
          )}
          {registry.isError && (
            <p className="px-3 py-2 text-xs text-warn">
              Registry unavailable — free text still works.
            </p>
          )}
          {registry.data && options.length === 0 && (
            <p className="px-3 py-2 text-xs text-ink-faint">No composers registered yet — type a name.</p>
          )}
          {options.map((opt, i) => {
            const rowCls = `w-full text-left px-3 py-2 text-sm flex items-center gap-2 min-w-0 ${
              hi === i ? "bg-paper" : "hover:bg-paper"
            }`;
            if (opt.kind === "create") {
              return (
                <button
                  key="__create__"
                  type="button"
                  className={`${rowCls} text-brand font-medium`}
                  disabled={create.isPending}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(opt)}
                >
                  {create.isPending ? "Creating…" : `+ Create "${opt.name}" as new composer`}
                </button>
              );
            }
            if (opt.kind === "unregistered") {
              return (
                <button
                  key={`u:${opt.value}`}
                  type="button"
                  className={rowCls}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(opt)}
                >
                  <span className="truncate">{opt.value}</span>
                  <span className="ml-auto flex items-center gap-2 shrink-0">
                    <span className="text-[11px] text-ink-faint">
                      {opt.pieceCount} piece{opt.pieceCount === 1 ? "" : "s"}
                    </span>
                    <ToneBadge tone="warn">unregistered</ToneBadge>
                  </span>
                </button>
              );
            }
            const c = opt.entry;
            const years =
              c.birthYear != null || c.deathYear != null
                ? `${c.birthYear ?? "?"}–${c.deathYear ?? "?"}`
                : null;
            return (
              <button
                key={`${opt.kind}:${c.id}${opt.kind === "alias" ? `:${opt.alias}` : ""}`}
                type="button"
                className={rowCls}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(opt)}
              >
                <span className="font-medium truncate">
                  {opt.kind === "alias" ? opt.alias : c.name}
                </span>
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  {opt.kind === "alias" ? (
                    <ToneBadge tone="muted">alias of {c.name}</ToneBadge>
                  ) : (
                    <span className="text-[11px] text-ink-faint">
                      {years ? `${years} · ` : ""}
                      {c.usageCount} in use
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {createErr && <p className="text-[11px] text-bad mt-1">{createErr}</p>}
      {showCreatedHint && (
        <p className="text-[11px] text-ink-faint mt-1">
          Registered "{created.name}" — add portrait, bio, and years in{" "}
          <Link
            className="text-brand hover:underline"
            to={`/collections?tab=composers&sel=${created.id}`}
          >
            Collections · Composers
          </Link>{" "}
          whenever convenient.
        </p>
      )}
      {showUnregisteredHint && !showCreatedHint && !open && registered === false && (
        <p className="text-[11px] text-warn mt-1">
          Not in the composer registry — select or create an entry, or keep as free text.
        </p>
      )}
    </div>
  );
}
