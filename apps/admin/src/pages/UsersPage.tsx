import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api, type AdminUser } from "../api";
import { ErrorNote, PageHeader, Spinner, statusTone, thCls } from "../components/ui";
import ToneBadge from "../components/ToneBadge";
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
                <TableHead className={thCls}>Email</TableHead>
                <TableHead className={thCls}>Name</TableHead>
                <TableHead className={thCls}>Roles</TableHead>
                <TableHead className={thCls}>Status</TableHead>
                <TableHead className={`${thCls} text-right`}>Joined</TableHead>
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
                <TableRow className="hover:bg-transparent">
                  <TableCell className="px-4 py-10 text-center whitespace-normal" colSpan={5}>
                    <p className="text-sm font-medium text-ink">
                      {q ? "No accounts match" : "No accounts yet"}
                    </p>
                    <p className="text-sm text-ink-soft mt-1">
                      {q
                        ? `Nothing found for "${q}" — try part of an email or display name.`
                        : "Accounts appear here after their first sign-in to the app."}
                    </p>
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
