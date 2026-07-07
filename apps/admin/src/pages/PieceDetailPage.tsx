import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, type AdminPieceDetail } from "../api";
import { Badge, Card, ErrorNote, PageHeader, Spinner, Td, Th, rightsTone, statusTone } from "../components/ui";

function formatBytes(n?: number): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function PieceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const query = useQuery<AdminPieceDetail, Error>({
    queryKey: ["piece", id],
    queryFn: () => api(`/admin/pieces/${id}`),
    enabled: !!id,
  });

  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorNote message={query.error.message} />;
  const p = query.data;

  return (
    <>
      <div className="mb-4">
        <Link to="/pieces" className="text-sm text-brand hover:underline">
          ← Pieces
        </Link>
      </div>
      <PageHeader
        title={p.title}
        subtitle={`${p.composer}${p.subtitle ? ` · ${p.subtitle}` : ""} · ${p.id}`}
        right={
          <div className="flex gap-1.5">
            <Badge tone={statusTone(p.status)}>{p.status}</Badge>
            <Badge tone={rightsTone(p.rights)}>{p.rights.replace("_", " ")}</Badge>
          </div>
        }
      />

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card className="p-4">
          <p className="text-xs text-ink-faint uppercase tracking-wide mb-1">Catalog</p>
          <p className="text-sm">
            mode <span className="font-medium">{p.mode}</span> · difficulty{" "}
            <span className="font-medium">{p.difficulty ?? "—"}</span> · tracking{" "}
            <span className="font-medium">{p.tracking}</span>
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-faint uppercase tracking-wide mb-1">Book</p>
          <p className="text-sm">
            {p.book ? (
              <>
                <span className="font-medium">{p.book.title}</span>
                {p.bookIndex != null && ` · #${p.bookIndex}`}
              </>
            ) : (
              "—"
            )}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-faint uppercase tracking-wide mb-1">Published</p>
          <p className="text-sm">
            {p.publishedVersion != null ? (
              <span className="font-medium">v{p.publishedVersion}</span>
            ) : (
              "not published"
            )}
          </p>
        </Card>
      </div>

      {p.rightsNote && (
        <Card className="p-4 mb-6">
          <p className="text-xs text-ink-faint uppercase tracking-wide mb-1">Rights note</p>
          <p className="text-sm text-ink-soft">{p.rightsNote}</p>
        </Card>
      )}

      {p.versions.map((v) => (
        <Card key={v.version} className="mb-4">
          <div className="px-4 py-3 flex items-center justify-between border-b border-line bg-paper/50">
            <span className="text-sm font-semibold">
              v{v.version}
              {v.version === p.publishedVersion && (
                <span className="ml-2 align-middle">
                  <Badge tone="ok">published</Badge>
                </span>
              )}
            </span>
            <span className="text-xs text-ink-faint tabular-nums">
              {new Date(v.publishedAt).toLocaleString()}
            </span>
          </div>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Role</Th>
                <Th>Variant</Th>
                <Th>Path</Th>
                <Th className="text-right">Size</Th>
              </tr>
            </thead>
            <tbody>
              {v.files.map((f, i) => (
                <tr key={i}>
                  <Td className="font-medium">{f.role}</Td>
                  <Td className="text-ink-soft">{f.variant ?? "—"}</Td>
                  <Td className="text-ink-soft font-mono text-xs">{f.path}</Td>
                  <Td className="text-right tabular-nums text-ink-soft">{formatBytes(f.bytes)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </>
  );
}
