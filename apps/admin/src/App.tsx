import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { API_SCOPE } from "./auth";
import { api, ApiError, type AdminUser } from "./api";
import { Spinner } from "./components/ui";
import { Button } from "@/components/ui-kit/button";
import { Separator } from "@/components/ui-kit/separator";
import { Toaster } from "@/components/ui-kit/sonner";
import UsersPage from "./pages/UsersPage";
import PiecesPage from "./pages/PiecesPage";
import PieceDetailPage from "./pages/PieceDetailPage";
import StudioPage from "./pages/StudioPage";
import StudioWizardPage from "./pages/StudioWizardPage";
import StudioJobPage from "./pages/StudioJobPage";

export default function App() {
  const authed = useIsAuthenticated();
  return (
    <>
      {authed ? <Shell /> : <SignIn />}
      <Toaster position="bottom-right" />
    </>
  );
}

function SignIn() {
  const { instance } = useMsal();
  return (
    <div className="min-h-screen grid place-items-center">
      <div className="bg-card border border-line rounded-2xl p-10 w-90 text-center shadow-sm">
        <div className="size-12 rounded-xl bg-brand-soft text-brand grid place-items-center mx-auto mb-4 text-lg font-bold">
          K
        </div>
        <h1 className="text-lg font-semibold">KaraOrchee Admin</h1>
        <p className="text-sm text-ink-soft mt-1 mb-6">Internal console. Admin accounts only.</p>
        <Button className="w-full" onClick={() => instance.loginRedirect({ scopes: [API_SCOPE] })}>
          Sign in
        </Button>
      </div>
    </div>
  );
}

function Shell() {
  const { instance } = useMsal();
  const account = instance.getAllAccounts()[0];
  const me = useQuery<AdminUser, Error>({
    queryKey: ["me"],
    // Sync first so a first-ever sign-in has a users row an admin can then flag.
    queryFn: async () => {
      await api("/v1/users/sync", { method: "POST" }).catch(() => {});
      return api<AdminUser>("/admin/me");
    },
    retry: false,
  });

  if (me.isPending) return <Spinner label="Checking access…" />;

  if (me.isError) {
    const forbidden = me.error instanceof ApiError && me.error.status === 403;
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="text-center">
          <h1 className="text-lg font-semibold">{forbidden ? "Not an admin account" : "Can't reach the API"}</h1>
          <p className="text-sm text-ink-soft mt-1 mb-4">
            {forbidden
              ? `${account?.username ?? "This account"} is signed in but has no admin access.`
              : me.error.message}
          </p>
          <Button variant="link" className="h-auto p-0" onClick={() => instance.logoutRedirect()}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  const nav = [
    { to: "/studio", label: "Pieces Studio" },
    { to: "/pieces", label: "Pieces Library" },
    { to: "/users", label: "Users" },
  ];

  return (
    <div className="min-h-screen flex">
      <aside className="w-52 shrink-0 border-r border-line bg-card flex flex-col">
        <div className="px-4 py-4 flex items-center gap-2">
          <div className="size-7 rounded-lg bg-brand-soft text-brand grid place-items-center text-sm font-bold">K</div>
          <span className="font-semibold text-sm">KaraOrchee Admin</span>
        </div>
        <Separator />
        <nav className="p-2 flex-1">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm font-medium mb-0.5 ${
                  isActive ? "bg-brand-soft text-brand" : "text-ink-soft hover:bg-paper"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <Separator />
        <div className="p-3">
          <p className="text-xs text-ink-faint truncate mb-1.5">{me.data.email ?? account?.username}</p>
          <Button
            variant="link"
            className="h-auto p-0 text-xs text-ink-soft hover:text-ink"
            onClick={() => instance.logoutRedirect()}
          >
            Sign out
          </Button>
        </div>
        <p className="px-1 pt-3 text-[10px] text-ink-faint tabular-nums select-all">
          v{__APP_VERSION__} · {__BUILD_SHA__}
        </p>
      </aside>
      <main className="flex-1 min-w-0 px-8 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/studio" replace />} />
          <Route path="/studio" element={<StudioPage />} />
          <Route path="/studio/new" element={<StudioWizardPage />} />
          <Route path="/studio/:id/edit" element={<StudioWizardPage />} />
          <Route path="/studio/:id" element={<StudioJobPage />} />
          <Route path="/pieces" element={<PiecesPage />} />
          <Route path="/pieces/:id" element={<PieceDetailPage />} />
          <Route path="/users" element={<UsersPage />} />
        </Routes>
      </main>
    </div>
  );
}
