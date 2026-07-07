import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type AdminPiece } from "../api";
import { Badge, Card, ErrorNote, PageHeader, Spinner, Td, Th, rightsTone, statusTone } from "../components/ui";

export default function PiecesPage() {
  const query = useQuery<{ items: AdminPiece[] }, Error>({
    queryKey: ["pieces"],
    queryFn: () => api("/admin/pieces"),
  });

  return (
    <>
      <PageHeader
        title="Pieces"
        subtitle={query.data ? `${query.data.items.length} in registry` : undefined}
      />
      {query.isPending && <Spinner />}
      {query.isError && <ErrorNote message={query.error.message} />}
      {query.data && (
        <Card>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Piece</Th>
                <Th>Composer</Th>
                <Th>Book</Th>
                <Th>Difficulty</Th>
                <Th>Tracking</Th>
                <Th>Rights</Th>
                <Th>Status</Th>
                <Th className="text-right">Version</Th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((p) => (
                <tr key={p.id} className="hover:bg-paper/60">
                  <Td className="font-medium">
                    <Link to={`/pieces/${p.id}`} className="text-brand hover:underline">
                      {p.title}
                    </Link>
                    {p.subtitle && <span className="text-ink-soft font-normal"> · {p.subtitle}</span>}
                  </Td>
                  <Td className="text-ink-soft">{p.composer}</Td>
                  <Td className="text-ink-soft">
                    {p.bookTitle ? `${p.bookTitle}${p.bookIndex != null ? ` #${p.bookIndex}` : ""}` : "—"}
                  </Td>
                  <Td className="tabular-nums">{p.difficulty ?? "—"}</Td>
                  <Td>
                    <Badge tone={p.tracking === "validated" ? "ok" : "muted"}>{p.tracking}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={rightsTone(p.rights)}>{p.rights.replace("_", " ")}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums text-ink-soft">
                    {p.publishedVersion != null ? `v${p.publishedVersion}` : "—"}
                    {p.latestVersion != null && p.latestVersion !== p.publishedVersion
                      ? ` (latest v${p.latestVersion})`
                      : ""}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
