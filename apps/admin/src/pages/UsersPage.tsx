import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api, type AdminUser } from "../api";
import { Badge, Card, ErrorNote, PageHeader, Spinner, Td, Th, statusTone } from "../components/ui";
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
          <input
            className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm w-64 outline-none focus:border-brand"
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
        <Card>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Email</Th>
                <Th>Name</Th>
                <Th>Roles</Th>
                <Th>Status</Th>
                <Th className="text-right">Joined</Th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((u) => (
                <tr key={u.id} className="hover:bg-paper/60 cursor-pointer" onClick={() => setSelected(u.id)}>
                  <Td className="font-medium">{u.email ?? <span className="text-ink-faint">—</span>}</Td>
                  <Td>{u.displayName ?? <span className="text-ink-faint">—</span>}</Td>
                  <Td>
                    <div className="flex gap-1.5">
                      {u.isAdmin && <Badge tone="brand">admin</Badge>}
                      {u.isTeacher && <Badge tone="ok">teacher</Badge>}
                      {u.isStudent && <Badge>student</Badge>}
                      {!u.isAdmin && !u.isTeacher && !u.isStudent && (
                        <span className="text-ink-faint text-sm">—</span>
                      )}
                    </div>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(u.status)}>{u.status}</Badge>
                  </Td>
                  <Td className="text-right text-ink-soft tabular-nums">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </Td>
                </tr>
              ))}
              {query.data.items.length === 0 && (
                <tr>
                  <Td className="text-ink-faint text-center py-8" colSpan={5}>
                    No matching users
                  </Td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
      {query.data && query.data.total > PAGE && (
        <div className="flex items-center justify-end gap-3 mt-3 text-sm">
          <button
            className="text-brand font-medium disabled:text-ink-faint"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Previous
          </button>
          <span className="text-ink-soft tabular-nums">
            {offset + 1}–{Math.min(offset + PAGE, query.data.total)} of {query.data.total}
          </span>
          <button
            className="text-brand font-medium disabled:text-ink-faint"
            disabled={offset + PAGE >= query.data.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </button>
        </div>
      )}
      {selected && <UserPanel userId={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
