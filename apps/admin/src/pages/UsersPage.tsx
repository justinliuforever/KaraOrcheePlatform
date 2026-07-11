import { useState } from "react";
import type { ReactNode } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api, type AdminUser } from "../api";
import { ErrorNote, PageHeader, Spinner, statusTone } from "../components/ui";
import { Badge } from "@/components/ui-kit/badge";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import { Input } from "@/components/ui-kit/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-kit/table";
import UserPanel from "../components/UserPanel";

const PAGE = 50;

// The tone MAPPING (statusTone) is unchanged — only the rendering swaps to a ui-kit
// Badge. ok/warn keep the house emerald/amber via the outline variant + custom classes.
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

function ToneBadge({ tone, children }: { tone: string; children: ReactNode }) {
  const t = TONE_VARIANT[tone] ?? TONE_VARIANT.muted;
  return (
    <Badge variant={t.variant} className={t.className}>
      {children}
    </Badge>
  );
}

const HEAD_CLS = "px-4 text-xs uppercase tracking-wide text-ink-faint";

export default function UsersPage() {
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery<{ items: AdminUser[]; total: number }, Error>({
    queryKey: ["users", q, offset],
    queryFn: () =>
      api(`/admin/users?limit=${PAGE}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Users"
        subtitle={query.data ? `${query.data.total} account${query.data.total === 1 ? "" : "s"}` : undefined}
        right={
          <Input
            className="w-64"
            placeholder="Search email or name…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
        }
      />
      {query.isPending && <Spinner />}
      {query.isError && <ErrorNote message={query.error.message} />}
      {query.data && (
        <Card className="overflow-hidden p-0 gap-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={HEAD_CLS}>Email</TableHead>
                <TableHead className={HEAD_CLS}>Name</TableHead>
                <TableHead className={HEAD_CLS}>Roles</TableHead>
                <TableHead className={HEAD_CLS}>Status</TableHead>
                <TableHead className={`${HEAD_CLS} text-right`}>Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.items.map((u) => (
                <TableRow key={u.id} className="cursor-pointer" onClick={() => setSelected(u.id)}>
                  <TableCell className="px-4 py-3 font-medium">
                    {u.email ?? <span className="text-ink-faint">—</span>}
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    {u.displayName ?? <span className="text-ink-faint">—</span>}
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <div className="flex gap-1.5">
                      {u.isAdmin && <ToneBadge tone="brand">admin</ToneBadge>}
                      {u.isTeacher && <ToneBadge tone="ok">teacher</ToneBadge>}
                      {u.isStudent && <ToneBadge tone="muted">student</ToneBadge>}
                      {!u.isAdmin && !u.isTeacher && !u.isStudent && (
                        <span className="text-ink-faint text-sm">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <ToneBadge tone={statusTone(u.status)}>{u.status}</ToneBadge>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right text-ink-soft tabular-nums">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
              {query.data.items.length === 0 && (
                <TableRow>
                  <TableCell className="px-4 text-ink-faint text-center py-8" colSpan={5}>
                    No matching users
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}
      {query.data && query.data.total > PAGE && (
        <div className="flex items-center justify-end gap-3 mt-3 text-sm">
          <Button
            variant="ghost"
            size="sm"
            className="text-brand"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Previous
          </Button>
          <span className="text-ink-soft tabular-nums">
            {offset + 1}–{Math.min(offset + PAGE, query.data.total)} of {query.data.total}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="text-brand"
            disabled={offset + PAGE >= query.data.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </Button>
        </div>
      )}
      {selected && <UserPanel userId={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
