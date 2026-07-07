import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type StudioJob } from "../api";
import { Badge, Card, ErrorNote, PageHeader, Spinner, Td, Th } from "../components/ui";

export function jobTone(status: StudioJob["status"]) {
  switch (status) {
    case "published":
      return "ok" as const;
    case "ready_for_review":
      return "brand" as const;
    case "failed":
      return "bad" as const;
    case "queued":
    case "running":
      return "warn" as const;
    default:
      return "muted" as const;
  }
}

const GATE_ORDER = ["sanity", "alignment", "geometry", "render"];

export function GateDots({ job }: { job: StudioJob }) {
  return (
    <div className="flex items-center gap-1" title={job.stage ?? ""}>
      {GATE_ORDER.map((g) => {
        const entry = job.gates?.[g];
        const color =
          entry?.status === "pass"
            ? "bg-ok"
            : entry?.status === "fail"
              ? "bg-bad"
              : entry?.status === "running"
                ? "bg-warn animate-pulse"
                : "bg-line";
        return <div key={g} className={`size-2 rounded-full ${color}`} title={`${g}: ${entry?.status ?? "pending"}`} />;
      })}
    </div>
  );
}

export default function StudioPage() {
  const query = useQuery<{ items: StudioJob[] }, Error>({
    queryKey: ["studio-jobs"],
    queryFn: () => api("/admin/studio/jobs"),
    refetchInterval: (q) =>
      q.state.data?.items.some((j) => j.status === "queued" || j.status === "running") ? 3000 : 15000,
  });

  return (
    <>
      <PageHeader
        title="Pieces Studio"
        subtitle="Upload MusicXML + MIDI, gates build and verify the bundle, then review and publish."
        right={
          <Link
            to="/studio/new"
            className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 hover:opacity-90"
          >
            New piece
          </Link>
        }
      />
      {query.isPending && <Spinner />}
      {query.isError && <ErrorNote message={query.error.message} />}
      {query.data && query.data.items.length === 0 && (
        <Card className="p-10 text-center text-sm text-ink-soft">
          No builds yet. Start with “New piece”.
        </Card>
      )}
      {query.data && query.data.items.length > 0 && (
        <Card>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Piece</Th>
                <Th>Status</Th>
                <Th>Gates</Th>
                <Th>Version</Th>
                <Th className="text-right">Started</Th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((j) => (
                <tr key={j.id} className="hover:bg-paper/60">
                  <Td className="font-medium">
                    <Link to={`/studio/${j.id}`} className="text-brand hover:underline">
                      {j.metadata?.title ?? j.pieceId}
                    </Link>
                    <span className="text-ink-faint font-normal font-mono text-xs"> {j.pieceId}</span>
                  </Td>
                  <Td>
                    <Badge tone={jobTone(j.status)}>{j.status.replaceAll("_", " ")}</Badge>
                    {j.status === "failed" && j.stage && (
                      <span className="text-xs text-ink-faint ml-1.5">at {j.stage}</span>
                    )}
                  </Td>
                  <Td>
                    <GateDots job={j} />
                  </Td>
                  <Td className="tabular-nums text-ink-soft">
                    {j.publishedVersion != null ? `v${j.publishedVersion}` : "—"}
                  </Td>
                  <Td className="text-right text-ink-soft tabular-nums text-xs">
                    {new Date(j.createdAt).toLocaleString()}
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
