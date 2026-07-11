import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api, type AdminUser, type AdminUserDetail, type RolePatch } from "../api";
import { ErrorNote, Spinner, statusTone } from "./ui";
import { Badge } from "@/components/ui-kit/badge";
import { Button } from "@/components/ui-kit/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui-kit/sheet";

// The panel is deliberately sectioned: Notes-phase sections (subscription/entitlements,
// lessons, teacher-student links) slot in as new <Section>s without reshaping this file.

// Tone MAPPING (statusTone) is unchanged — only rendering swaps to a ui-kit Badge.
const TONE_VARIANT: Record<
  string,
  { variant: "default" | "secondary" | "destructive" | "outline"; className?: string }
> = {
  brand: { variant: "default" },
  bad: { variant: "destructive" },
  muted: { variant: "secondary" },
  ok: { variant: "outline", className: "border-emerald-200 bg-emerald-50 text-ok" },
  warn: { variant: "outline", className: "border-amber-200 bg-amber-50 text-warn" },
};

function ToneBadge({ tone, children }: { tone: string; children: ReactNode }) {
  const t = TONE_VARIANT[tone] ?? TONE_VARIANT.muted;
  return (
    <Badge variant={t.variant} className={t.className}>
      {children}
    </Badge>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-5 py-4 border-b border-line">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-3">{title}</p>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-xs text-ink-faint shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-ink text-right break-all">{children}</span>
    </div>
  );
}

function RoleToggle({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      className={`w-full flex items-center justify-between rounded-lg border px-3 py-2.5 mb-2 text-left
        ${value ? "border-indigo-200 bg-brand-soft" : "border-line bg-card"}
        ${disabled ? "opacity-50 cursor-not-allowed" : "hover:border-brand/50"}`}
      disabled={disabled}
      onClick={() => onChange(!value)}
    >
      <span>
        <span className="text-sm font-medium block">{label}</span>
        {hint && <span className="text-[11px] text-ink-faint">{hint}</span>}
      </span>
      <span
        className={`w-9 h-5 rounded-full relative transition-colors ${value ? "bg-brand" : "bg-line"}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${value ? "left-4.5" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}

export default function UserPanel({ userId, onClose }: { userId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const me = qc.getQueryData<AdminUser>(["me"]);

  const detail = useQuery<AdminUserDetail, Error>({
    queryKey: ["user", userId],
    queryFn: () => api(`/admin/users/${userId}`),
  });

  const roles = useMutation<AdminUser, Error, RolePatch>({
    mutationFn: (patch) =>
      api(`/admin/users/${userId}/roles`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user", userId] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const u = detail.data?.user;
  const isSelf = me?.id === userId;

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className="w-105 max-w-full gap-0 overflow-y-auto bg-card p-0 sm:max-w-full"
      >
        <div className="px-5 py-4 border-b border-line flex items-center justify-between sticky top-0 bg-card z-10">
          <div className="min-w-0">
            <SheetTitle className="text-sm font-semibold truncate">{u?.email ?? "User"}</SheetTitle>
            {u?.displayName && <p className="text-xs text-ink-faint truncate">{u.displayName}</p>}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-ink-faint hover:text-ink text-xl leading-none"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </Button>
        </div>

        {detail.isPending && <Spinner />}
        {detail.isError && (
          <div className="p-5">
            <ErrorNote message={detail.error.message} />
          </div>
        )}

        {u && (
          <>
            <Section title="Roles">
              <RoleToggle
                label="Admin"
                hint={isSelf ? "You can't remove your own admin access" : "Full console access"}
                value={u.isAdmin}
                disabled={roles.isPending || (isSelf && u.isAdmin)}
                onChange={(v) => roles.mutate({ isAdmin: v })}
              />
              <RoleToggle
                label="Teacher"
                hint="Records lessons, invites students (Notes phase)"
                value={u.isTeacher}
                disabled={roles.isPending}
                onChange={(v) => roles.mutate({ isTeacher: v })}
              />
              <RoleToggle
                label="Student"
                hint="Receives lesson notes from a teacher (Notes phase)"
                value={u.isStudent}
                disabled={roles.isPending}
                onChange={(v) => roles.mutate({ isStudent: v })}
              />
              {roles.isError && <ErrorNote message={roles.error.message} />}
            </Section>

            <Section title="Account">
              <Row label="Status">
                <ToneBadge tone={statusTone(u.status)}>{u.status}</ToneBadge>
              </Row>
              <Row label="Joined">{new Date(u.createdAt).toLocaleString()}</Row>
              <Row label="Updated">{new Date(u.updatedAt).toLocaleString()}</Row>
              <Row label="Referred by">{u.referredBy ?? "—"}</Row>
            </Section>

            <Section title="Identity">
              <Row label="User ID">
                <span className="font-mono text-xs">{u.id}</span>
              </Row>
              <Row label="Entra OID">
                <span className="font-mono text-xs">{u.entraOid ?? "— (scrubbed)"}</span>
              </Row>
            </Section>

            <Section title="Subscription & lessons">
              <p className="text-xs text-ink-faint leading-relaxed">
                Trial / subscription state, lesson history, and teacher–student links appear here
                once the Notes phase ships.
              </p>
            </Section>

            <Section title="Admin history">
              {detail.data!.recentAudit.length === 0 ? (
                <p className="text-xs text-ink-faint">No admin actions on this account yet.</p>
              ) : (
                detail.data!.recentAudit.map((e) => (
                  <div key={e.id} className="py-1.5 border-b border-line/60 last:border-0">
                    <p className="text-xs font-medium">{e.action}</p>
                    <p className="text-[11px] text-ink-faint">
                      {new Date(e.createdAt).toLocaleString()}
                      {e.detail && "changes" in e.detail
                        ? ` · ${JSON.stringify(e.detail.changes)}`
                        : ""}
                    </p>
                  </div>
                ))
              )}
            </Section>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
