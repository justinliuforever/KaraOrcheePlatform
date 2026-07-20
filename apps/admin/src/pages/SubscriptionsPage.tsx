import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  getMonetization,
  grantEntitlement,
  listEntitlements,
  putMonetization,
  revokeEntitlement,
  type AdminUser,
  type MonetizationConfig,
  type NoteEntitlement,
} from "../api";
import { ErrorNote, PageHeader, Spinner, thCls } from "../components/ui";
import ToneBadge from "../components/ToneBadge";
import UserPicker from "../components/UserPicker";
import NotesActivitySheet from "../components/NotesActivitySheet";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import { Checkbox } from "@/components/ui-kit/checkbox";
import { Input } from "@/components/ui-kit/input";
import { Label } from "@/components/ui-kit/label";
import { Textarea } from "@/components/ui-kit/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui-kit/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui-kit/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui-kit/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-kit/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui-kit/tabs";

const sourceTone: Record<string, string> = {
  trial: "muted",
  apple_iap: "brand",
  admin_grant: "ok",
  org: "brand",
};
const statusTone: Record<string, string> = {
  active: "ok",
  grace: "warn",
  expired: "muted",
  revoked: "bad",
};

function useDebounced(value: string, ms = 300): string {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value.trim()), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

export default function SubscriptionsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "monetization" ? "monetization" : "entitlements";
  const [activity, setActivity] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Subscriptions"
        subtitle="Notes entitlements and the monetization switch"
        right={tab === "entitlements" ? <GrantButton /> : undefined}
      />

      <div className="mb-4">
        <Tabs value={tab} onValueChange={(v) => setParams(v === "entitlements" ? {} : { tab: v })}>
          <TabsList>
            <TabsTrigger value="entitlements">Entitlements</TabsTrigger>
            <TabsTrigger value="monetization">Monetization</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {tab === "entitlements" ? <EntitlementsTab onOpenActivity={setActivity} /> : <MonetizationTab />}

      {activity && <NotesActivitySheet key={activity} userId={activity} onClose={() => setActivity(null)} />}
    </>
  );
}

// ── Entitlements ────────────────────────────────────────────────────────────────

function EntitlementsTab({ onOpenActivity }: { onOpenActivity: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [revokeTarget, setRevokeTarget] = useState<NoteEntitlement | null>(null);

  const query = useQuery<{ items: NoteEntitlement[] }, Error>({
    queryKey: ["entitlements", q, source, status],
    queryFn: () => listEntitlements(q, source === "all" ? "" : source, status === "all" ? "" : status),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <Input
          className="w-72"
          placeholder="Search user email / name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="trial">Trial</SelectItem>
            <SelectItem value="apple_iap">Apple IAP</SelectItem>
            <SelectItem value="admin_grant">Admin grant</SelectItem>
            <SelectItem value="org">Org</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="grace">Grace</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
            <SelectItem value="revoked">Revoked</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {query.isPending && <Spinner />}
      {query.isError && <ErrorNote message={query.error.message} />}
      {query.data && (
        <Card className={cn("overflow-hidden p-0 gap-0", query.isFetching && "opacity-60")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={thCls}>User</TableHead>
                <TableHead className={thCls}>Source</TableHead>
                <TableHead className={thCls}>Status</TableHead>
                <TableHead className={thCls}>Starts</TableHead>
                <TableHead className={thCls}>Expires</TableHead>
                <TableHead className={thCls}>Reason / txn</TableHead>
                <TableHead className={`${thCls} text-right`}>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="px-4 py-2.5">
                    <button
                      className="text-left rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      onClick={() => onOpenActivity(e.userId)}
                      title="View notes activity"
                    >
                      <span className="block text-sm font-medium text-brand hover:underline">
                        {e.userEmail ?? <span className="text-ink-faint">—</span>}
                      </span>
                      {e.userName && <span className="block text-xs text-ink-faint">{e.userName}</span>}
                    </button>
                  </TableCell>
                  <TableCell className="px-4 py-2.5">
                    <ToneBadge tone={sourceTone[e.source] ?? "muted"}>{e.source.replaceAll("_", " ")}</ToneBadge>
                  </TableCell>
                  <TableCell className="px-4 py-2.5">
                    <ToneBadge tone={statusTone[e.status] ?? "muted"}>{e.status}</ToneBadge>
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-xs text-ink-soft tabular-nums">
                    {fmtDate(e.startsAt)}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-xs text-ink-soft tabular-nums">
                    <span title={e.expiresAt ? new Date(e.expiresAt).toLocaleString() : undefined}>
                      {e.expiresAt ? fmtDate(e.expiresAt) : "never"}
                    </span>
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-xs text-ink-soft max-w-56">
                    {e.reason ? (
                      <span className="block truncate" title={e.reason}>{e.reason}</span>
                    ) : e.appleOriginalTransactionId ? (
                      <span className="block truncate font-mono" title={e.appleOriginalTransactionId}>
                        txn {e.appleOriginalTransactionId}
                      </span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right">
                    {e.status === "active" || e.status === "grace" ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-bad hover:text-bad"
                        onClick={() => setRevokeTarget(e)}
                      >
                        Revoke
                      </Button>
                    ) : (
                      <span className="text-xs text-ink-faint">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {query.data.items.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell className="px-4 py-10 text-center whitespace-normal" colSpan={7}>
                    <p className="text-sm font-medium text-ink">No entitlements found</p>
                    <p className="text-sm text-ink-soft mt-1">
                      Trials, App Store subscriptions, and admin grants appear here.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      <RevokeEntitlementDialog target={revokeTarget} onDone={() => setRevokeTarget(null)} />
    </>
  );
}

function GrantButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Grant access</Button>
      <GrantDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

const DAY_PRESETS = ["7", "30", "90", "custom"] as const;

function GrantDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [daysPreset, setDaysPreset] = useState<string>("30");
  const [customDays, setCustomDays] = useState("");
  const [reason, setReason] = useState("");

  const days = daysPreset === "custom" ? Number(customDays) : Number(daysPreset);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= 3650;
  const reasonValid = reason.trim().length >= 10;

  const reset = () => {
    setUser(null);
    setDaysPreset("30");
    setCustomDays("");
    setReason("");
  };

  const grant = useMutation<unknown, Error>({
    mutationFn: () => grantEntitlement({ userId: user!.id, days, reason: reason.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["entitlements"] });
      toast.success(`Granted ${days} day${days === 1 ? "" : "s"} of Notes access`);
      onOpenChange(false);
      reset();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Grant Notes access</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <UserPicker label="User" value={user} onChange={setUser} />
          <div>
            <Label className="mb-1.5">Duration</Label>
            <div className="flex items-center gap-2">
              <Select value={daysPreset} onValueChange={setDaysPreset}>
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_PRESETS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d === "custom" ? "Custom…" : `${d} days`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {daysPreset === "custom" && (
                <Input
                  type="number"
                  min={1}
                  max={3650}
                  className="w-28"
                  placeholder="days"
                  value={customDays}
                  onChange={(e) => setCustomDays(e.target.value)}
                />
              )}
            </div>
          </div>
          <div>
            <Label className="mb-1.5">
              Reason <span className="text-bad">*</span> — at least 10 characters, recorded in the audit trail
            </Label>
            <Textarea
              placeholder="e.g. Comped for beta feedback partner — 2026 pilot cohort"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-ink-faint tabular-nums">{reason.trim().length}/10</p>
          </div>
          {grant.isError && <ErrorNote message={grant.error.message} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!user || !daysValid || !reasonValid || grant.isPending} onClick={() => grant.mutate()}>
            {grant.isPending ? "Granting…" : "Grant access"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeEntitlementDialog({ target, onDone }: { target: NoteEntitlement | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const reasonValid = reason.trim().length >= 10;

  const revoke = useMutation<unknown, Error>({
    mutationFn: () => revokeEntitlement(target!.id, reason.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["entitlements"] });
      toast.success("Entitlement revoked");
      onDone();
      setReason("");
    },
  });

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) {
          onDone();
          setReason("");
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {target?.source.replaceAll("_", " ")} access?</AlertDialogTitle>
          <AlertDialogDescription>
            {target?.userEmail ?? "This user"} loses Notes access immediately. Give a reason (at least
            10 characters) — it's recorded in the audit trail.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div>
          <Textarea
            placeholder="e.g. Duplicate grant issued in error — see support ticket 412"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-ink-faint tabular-nums">{reason.trim().length}/10</p>
          {revoke.isError && <div className="mt-2"><ErrorNote message={revoke.error.message} /></div>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!reasonValid || revoke.isPending}
            onClick={(e) => {
              // Always keep the dialog open (Radix Action closes by default): the mutation
              // is async, and an in-dialog error must survive the click. Close on success.
              e.preventDefault();
              if (!reasonValid) return;
              revoke.mutate();
            }}
          >
            {revoke.isPending ? "Revoking…" : "Revoke access"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Monetization ────────────────────────────────────────────────────────────────

function MonetizationTab() {
  const q = useQuery<MonetizationConfig, Error>({
    queryKey: ["monetization"],
    queryFn: getMonetization,
  });
  const [edit, setEdit] = useState<"set" | "clear" | null>(null);

  return (
    <>
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNote message={q.error.message} />}
      {q.data && (
        <Card className="max-w-xl gap-4 p-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">Current state</p>
            <div className="mt-2 flex items-center gap-2.5">
              {q.data.state === "beta_free" ? (
                <>
                  <ToneBadge tone="ok">Beta — free</ToneBadge>
                  <p className="text-sm text-ink">Notes are free for everyone. No paywall is scheduled.</p>
                </>
              ) : (
                <>
                  <ToneBadge tone="warn">Paid after</ToneBadge>
                  <p className="text-sm text-ink">
                    Trial clocks anchor to{" "}
                    <span className="font-medium tabular-nums">
                      {q.data.value ? new Date(q.data.value).toLocaleString() : "—"}
                    </span>
                    . Every student gets a fresh 30-day trial from that moment.
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm text-warn">
              Changing this moves every student's trial clock at once. It launches (or unlaunches) the
              paywall platform-wide — treat it as a release action.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={() => setEdit("set")}>Set / change paywall date</Button>
            {q.data.state === "paid_after" && (
              <Button variant="outline" onClick={() => setEdit("clear")}>
                Clear (back to beta-free)
              </Button>
            )}
          </div>
        </Card>
      )}

      <MonetizationDialog mode={edit} current={q.data ?? null} onClose={() => setEdit(null)} />
    </>
  );
}

function MonetizationDialog({
  mode,
  current,
  onClose,
}: {
  mode: "set" | "clear" | null;
  current: MonetizationConfig | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [dt, setDt] = useState("");
  const [ack, setAck] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  // Seed the datetime input from the current value each time the Set dialog opens.
  useEffect(() => {
    if (mode === "set") {
      setDt(current?.value ? toLocalInput(current.value) : "");
    }
    setAck(false);
    setConfirmText("");
  }, [mode, current?.value]);

  const phrase = mode === "clear" ? "CLEAR" : "MONETIZE";
  const iso = mode === "set" ? localInputToIso(dt) : null;
  const dateValid = mode === "clear" || iso !== null;
  const canConfirm = ack && confirmText.trim().toUpperCase() === phrase && dateValid;

  const save = useMutation<MonetizationConfig, Error>({
    mutationFn: () => putMonetization(mode === "clear" ? null : iso),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["monetization"] });
      toast.success(
        res.state === "beta_free"
          ? "Monetization cleared — Notes are free for everyone"
          : `Paywall date set to ${res.value ? new Date(res.value).toLocaleString() : ""}`,
      );
      onClose();
    },
  });

  return (
    <AlertDialog open={mode !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {mode === "clear" ? "Clear the paywall date?" : "Set the paywall date?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {mode === "clear"
              ? "This returns everyone to beta-free: no paywall, all Notes free. Existing trial rows stop mattering."
              : "This launches the paywall. Every student's 30-day trial anchors to this moment (or their signup, whichever is later)."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          {mode === "set" && (
            <div>
              <Label className="mb-1.5">Paywall goes live at (local time)</Label>
              <Input type="datetime-local" value={dt} onChange={(e) => setDt(e.target.value)} />
              {dt && iso && (
                <p className="mt-1 text-[11px] text-ink-faint">
                  UTC: <span className="tabular-nums">{iso}</span>
                </p>
              )}
              {dt && !iso && <p className="mt-1 text-[11px] text-bad">Not a valid date/time.</p>}
            </div>
          )}

          <label className="flex items-start gap-2.5 rounded-lg border border-line bg-card px-3 py-2.5 cursor-pointer">
            <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} className="mt-0.5" />
            <span className="text-sm">I understand this changes every student's trial clock.</span>
          </label>

          <div>
            <Label className="mb-1.5">
              Type <span className="font-mono font-semibold">{phrase}</span> to confirm
            </Label>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={phrase}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {save.isError && <ErrorNote message={save.error.message} />}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!canConfirm || save.isPending}
            onClick={(e) => {
              // Stay open until PUT resolves so an invalid_value error stays visible.
              e.preventDefault();
              if (!canConfirm) return;
              save.mutate();
            }}
          >
            {save.isPending ? "Applying…" : mode === "clear" ? "Clear paywall" : "Set paywall date"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** ISO → value for <input type="datetime-local"> (local wall time, minute precision). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
