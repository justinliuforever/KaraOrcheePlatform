import { Navigate, useParams } from "react-router-dom";

// Intentional redirect shim: keeps one canonical piece view (Library slide-over) so deep links can't drift from it.
export default function PieceDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/pieces?sel=${encodeURIComponent(id ?? "")}`} replace />;
}
