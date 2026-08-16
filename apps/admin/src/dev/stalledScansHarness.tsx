// DEV-ONLY: its HTML entry is one `vite build` never names, so nothing here can reach a bundle.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import OpsPage from "../pages/OpsPage";
import type { StalledScan } from "../api";
import "../index.css";

const rows: StalledScan[] = [
  { id: "s1", ownerId: "u1", ownerEmail: "ms.rivera@example.com", title: "Czerny Op. 599 No. 31",
    status: "created", pageCount: 5, createdAt: "2026-08-15T02:10:00.000Z",
    updatedAt: "2026-08-15T02:11:00.000Z", hasBytes: false, referencedBy: 0 },
  { id: "s2", ownerId: "u2", ownerEmail: null, title: "Le Courant limpide",
    status: "created", pageCount: 2, createdAt: "2026-08-14T18:00:00.000Z",
    updatedAt: "2026-08-14T18:04:00.000Z", hasBytes: true, referencedBy: 1 },
];

const shape = new URLSearchParams(location.search).get("shape") ?? "some";
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
qc.setQueryData(["stalled-scans", 6], { hours: 6, scans: shape === "none" ? [] : rows });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/ops?view=stalled-scans&hours=6"]}>
        <OpsPage />
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
