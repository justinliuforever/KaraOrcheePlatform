import { Navigate, useParams } from "react-router-dom";

// One canonical piece view: the Library slide-over. Deep links (publish nav, audit
// trails, bookmarks) land here and forward into it, so the two can never drift.
export default function PieceDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/pieces?sel=${encodeURIComponent(id ?? "")}`} replace />;
}
