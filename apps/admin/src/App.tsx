import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { API_SCOPE } from "./auth";
import { api, ApiError, type AdminUser } from "./api";
import { Spinner } from "./components/ui";
import UsersPage from "./pages/UsersPage";
import PiecesPage from "./pages/PiecesPage";
import PieceDetailPage from "./pages/PieceDetailPage";

export default function App() {
  const authed = useIsAuthenticated();
  return authed ? <Shell /> : <SignIn />;
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
        <button
          className="w-full rounded-lg bg-brand text-white text-sm font-medium py-2.5 hover:opacity-90"
          onClick={() => instance.loginRedirect({ scopes: [API_SCOPE] })}
        >
          Sign in
        </button>
      </div>
    </div>
  );
}

function Shell() {
  const { instance } = useMsal();
  const account = instance.getAllAccounts()[0];
  const me = useQuery<AdminUser, Error>({
    queryKey: ["me"],
    queryFn: () => api<AdminUser>("/admin/me"),
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
          <button
            className="text-sm text-brand font-medium"
            onClick={() => instance.logoutRedirect()}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const nav = [
    { to: "/pieces", label: "Pieces" },
    { to: "/users", label: "Users" },
  ];

  return (
    <div className="min-h-screen flex">
      <aside className="w-52 shrink-0 border-r border-line bg-card flex flex-col">
        <div className="px-4 py-4 flex items-center gap-2 border-b border-line">
          <div className="size-7 rounded-lg bg-brand-soft text-brand grid place-items-center text-sm font-bold">K</div>
          <span className="font-semibold text-sm">KaraOrchee Admin</span>
        </div>
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
        <div className="p-3 border-t border-line">
          <p className="text-xs text-ink-faint truncate mb-1.5">{me.data.email ?? account?.username}</p>
          <button className="text-xs text-ink-soft hover:text-ink font-medium" onClick={() => instance.logoutRedirect()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 min-w-0 px-8 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/pieces" replace />} />
          <Route path="/pieces" element={<PiecesPage />} />
          <Route path="/pieces/:id" element={<PieceDetailPage />} />
          <Route path="/users" element={<UsersPage />} />
        </Routes>
      </main>
    </div>
  );
}
