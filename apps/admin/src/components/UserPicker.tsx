import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, type AdminUser } from "../api";
import ToneBadge from "./ToneBadge";
import { Button } from "@/components/ui-kit/button";
import { Label } from "@/components/ui-kit/label";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui-kit/command";

/** Account combobox backed by the Users search endpoint. Server-side search only
 * (shouldFilter off) — there is no global directory, so a query is required. */
export default function UserPicker({
  label,
  value,
  onChange,
  excludeId,
  placeholder = "Search email or name…",
}: {
  label: string;
  value: AdminUser | null;
  onChange: (u: AdminUser | null) => void;
  excludeId?: string | null;
  placeholder?: string;
}) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const usersQ = useQuery<{ items: AdminUser[]; total: number }, Error>({
    queryKey: ["users-picker", q],
    queryFn: () => api(`/admin/users?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });

  if (value) {
    return (
      <div>
        <Label className="mb-1.5">{label}</Label>
        <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-card px-3 py-2">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{value.email ?? "—"}</span>
            {value.displayName && <span className="block truncate text-xs text-ink-faint">{value.displayName}</span>}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="text-ink-soft"
            onClick={() => {
              onChange(null);
              setSearch("");
            }}
          >
            Change
          </Button>
        </div>
      </div>
    );
  }

  const items = (usersQ.data?.items ?? []).filter((u) => u.id !== excludeId);

  return (
    <div>
      <Label className="mb-1.5">{label}</Label>
      <Command shouldFilter={false} className="rounded-md border border-line bg-card">
        <CommandInput placeholder={placeholder} value={search} onValueChange={setSearch} />
        <CommandList className="max-h-44">
          {q.length === 0 && (
            <p className="px-3 py-3 text-xs text-ink-faint">Type to search accounts.</p>
          )}
          {q.length > 0 && usersQ.isFetching && items.length === 0 && (
            <p className="px-3 py-3 text-xs text-ink-faint">Searching…</p>
          )}
          {q.length > 0 && !usersQ.isFetching && items.length === 0 && (
            <p className="px-3 py-3 text-xs text-ink-faint">No accounts match “{q}”.</p>
          )}
          {items.map((u) => (
            <CommandItem
              key={u.id}
              value={u.id}
              onSelect={() => {
                onChange(u);
                setSearch("");
              }}
            >
              <span className="min-w-0 flex-1 truncate">
                {u.email ?? "—"}
                {u.displayName && <span className="text-ink-faint"> · {u.displayName}</span>}
              </span>
              <span className="ml-auto flex shrink-0 gap-1">
                {u.isTeacher && <ToneBadge tone="ok">teacher</ToneBadge>}
                {u.isStudent && <ToneBadge tone="muted">student</ToneBadge>}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  );
}
