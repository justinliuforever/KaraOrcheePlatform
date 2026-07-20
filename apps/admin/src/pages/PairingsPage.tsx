import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  createNoteLink,
  listNoteInvites,
  listNoteLinks,
  removeNoteLink,
  revokeNoteInvite,
  type AdminUser,
  type NoteInvite,
  type NoteLink,
} from "../api";
import { ErrorNote, PageHeader, Spinner, thCls } from "../components/ui";
import ToneBadge from "../components/ToneBadge";
import UserPicker from "../components/UserPicker";
import NotesActivitySheet from "../components/NotesActivitySheet";
import { timeAgo } from "../studio/gateInfo";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui-kit/button";
import { Card } from "@/components/ui-kit/card";
import { Input } from "@/components/ui-kit/input";
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

const linkTone: Record<string, string> = { active: "ok", removed: "muted" };
const inviteTone: Record<string, string> = {
  active: "ok",
  expired: "muted",
  exhausted: "warn",
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

export default function PairingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "invites" ? "invites" : "links";
  // Which account's activity sheet is open (opened from a teacher / student cell).
  const [activity, setActivity] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Pairings"
        subtitle="Teacher–student links and the invite codes that create them"
        right={tab === "links" ? <CreateLinkButton /> : undefined}
      />

      <div className="mb-4">
        <Tabs value={tab} onValueChange={(v) => setParams(v === "links" ? {} : { tab: v })}>
          <TabsList>
            <TabsTrigger value="links">Links</TabsTrigger>
            <TabsTrigger value="invites">Invites</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {tab === "links" ? (
        <LinksTab onOpenActivity={setActivity} />
      ) : (
        <InvitesTab onOpenActivity={setActivity} />
      )}

      {activity && <NotesActivitySheet key={activity} userId={activity} onClose={() => setActivity(null)} />}
    </>
  );
}

// ── Links ─────────────────────────────────────────────────────────────────────

function LinksTab({ onOpenActivity }: { onOpenActivity: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const [status, setStatus] = useState("all");
  const [removeTarget, setRemoveTarget] = useState<NoteLink | null>(null);

  const query = useQuery<{ items: NoteLink[] }, Error>({
    queryKey: ["note-links", q, status],
    queryFn: () => listNoteLinks(q, status === "all" ? "" : status),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <Input
          className="w-72"
          placeholder="Search teacher or student email / name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="removed">Removed</SelectItem>
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
                <TableHead className={thCls}>Teacher</TableHead>
                <TableHead className={thCls}>Student</TableHead>
                <TableHead className={thCls}>Status</TableHead>
                <TableHead className={thCls}>Via</TableHead>
                <TableHead className={thCls}>Attested</TableHead>
                <TableHead className={thCls}>Linked</TableHead>
                <TableHead className={`${thCls} text-right`}>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.items.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="px-4 py-2.5">
                    <PartyCell email={l.teacherEmail} name={l.teacherName} id={l.teacherId} onOpen={onOpenActivity} />
                  </TableCell>
                  <TableCell className="px-4 py-2.5">
                    <PartyCell email={l.studentEmail} name={l.studentName} id={l.studentId} onOpen={onOpenActivity} />
                  </TableCell>
                  <TableCell className="px-4 py-2.5">
                    <ToneBadge tone={linkTone[l.status] ?? "muted"}>{l.status}</ToneBadge>
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-xs text-ink-soft">
                    {l.createdVia.replaceAll("_", " ")}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-xs text-ink-soft tabular-nums">
                    {fmtDate(l.consentAt)}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-xs text-ink-soft tabular-nums">
                    <span title={new Date(l.createdAt).toLocaleString()}>{timeAgo(l.createdAt)}</span>
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right">
                    {l.status === "active" ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-bad hover:text-bad"
                        onClick={() => setRemoveTarget(l)}
                      >
                        Remove
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
                    <p className="text-sm font-medium text-ink">No links found</p>
                    <p className="text-sm text-ink-soft mt-1">
                      Links appear when a student redeems an invite, or create one directly.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      <RemoveLinkDialog target={removeTarget} onDone={() => setRemoveTarget(null)} />
    </>
  );
}

function PartyCell({
  email,
  name,
  id,
  onOpen,
}: {
  email: string | null;
  name: string | null;
  id: string;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      className="text-left rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      onClick={() => onOpen(id)}
      title="View notes activity"
    >
      <span className="block text-sm font-medium text-brand hover:underline">
        {email ?? <span className="text-ink-faint">—</span>}
      </span>
      {name && <span className="block text-xs text-ink-faint">{name}</span>}
    </button>
  );
}

function CreateLinkButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Create link</Button>
      <CreateLinkDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function CreateLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [teacher, setTeacher] = useState<AdminUser | null>(null);
  const [student, setStudent] = useState<AdminUser | null>(null);

  const create = useMutation<unknown, Error>({
    mutationFn: () => createNoteLink(teacher!.id, student!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["note-links"] });
      toast.success("Pairing created");
      onOpenChange(false);
      setTeacher(null);
      setStudent(null);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setTeacher(null);
          setStudent(null);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create teacher–student link</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-ink-soft leading-relaxed">
            Force-creates a pairing outside the invite flow (support / school onboarding). Grants
            the teacher and student roles if missing. The attestation timestamp is an admin
            record, not the family's in-app recording consent.
          </p>
          <UserPicker label="Teacher" value={teacher} onChange={setTeacher} excludeId={student?.id} />
          <UserPicker label="Student" value={student} onChange={setStudent} excludeId={teacher?.id} />
          {create.isError && <ErrorNote message={create.error.message} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!teacher || !student || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveLinkDialog({ target, onDone }: { target: NoteLink | null; onDone: () => void }) {
  const qc = useQueryClient();
  const remove = useMutation<unknown, Error, string>({
    mutationFn: (id) => removeNoteLink(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["note-links"] });
      toast.success("Link removed");
      onDone();
    },
    onError: (e) => {
      toast.error(e.message);
      onDone();
    },
  });

  return (
    <AlertDialog open={target !== null} onOpenChange={(o) => !o && onDone()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this pairing?</AlertDialogTitle>
          <AlertDialogDescription>
            {target?.teacherEmail ?? "The teacher"} will no longer be linked to{" "}
            {target?.studentEmail ?? "this student"}. New lessons can't be sent, but past notes stay
            with the student. The link can be re-created later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => target && remove.mutate(target.id)}
          >
            {remove.isPending ? "Removing…" : "Remove link"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Invites ─────────────────────────────────────────────────────────────────────

function InvitesTab({ onOpenActivity }: { onOpenActivity: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const [state, setState] = useState("all");
  const [revokeTarget, setRevokeTarget] = useState<NoteInvite | null>(null);

  const query = useQuery<{ items: NoteInvite[] }, Error>({
    queryKey: ["note-invites", q, state],
    queryFn: () => listNoteInvites(q, state === "all" ? "" : state),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <Input
          className="w-72"
          placeholder="Search issuing teacher email / name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={state} onValueChange={setState}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All states</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
            <SelectItem value="exhausted">Exhausted</SelectItem>
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
                <TableHead className={thCls}>Code</TableHead>
                <TableHead className={thCls}>Teacher</TableHead>
                <TableHead className={thCls}>State</TableHead>
                <TableHead className={`${thCls} text-right`}>Used</TableHead>
                <TableHead className={thCls}>Expires</TableHead>
                <TableHead className={`${thCls} text-right`}>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.items.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="px-4 py-2.5 font-mono text-sm">{inv.code}</TableCell>
                  <TableCell className="px-4 py-2.5">
                    <PartyCell email={inv.teacherEmail} name={inv.teacherName} id={inv.teacherId} onOpen={onOpenActivity} />
                  </TableCell>
                  <TableCell className="px-4 py-2.5">
                    <ToneBadge tone={inviteTone[inv.state] ?? "muted"}>{inv.state}</ToneBadge>
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right text-xs text-ink-soft tabular-nums">
                    {inv.usedCount}/{inv.maxUses}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-xs text-ink-soft tabular-nums">
                    <span title={new Date(inv.expiresAt).toLocaleString()}>{fmtDate(inv.expiresAt)}</span>
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right">
                    {inv.state === "active" ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-bad hover:text-bad"
                        onClick={() => setRevokeTarget(inv)}
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
                  <TableCell className="px-4 py-10 text-center whitespace-normal" colSpan={6}>
                    <p className="text-sm font-medium text-ink">No invites found</p>
                    <p className="text-sm text-ink-soft mt-1">
                      Teachers generate invite codes in the app to link students.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      <RevokeInviteDialog target={revokeTarget} onDone={() => setRevokeTarget(null)} />
    </>
  );
}

function RevokeInviteDialog({ target, onDone }: { target: NoteInvite | null; onDone: () => void }) {
  const qc = useQueryClient();
  const revoke = useMutation<unknown, Error, string>({
    mutationFn: (id) => revokeNoteInvite(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["note-invites"] });
      toast.success("Invite revoked");
      onDone();
    },
    onError: (e) => {
      toast.error(e.message);
      onDone();
    },
  });

  return (
    <AlertDialog open={target !== null} onOpenChange={(o) => !o && onDone()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke invite {target?.code}?</AlertDialogTitle>
          <AlertDialogDescription>
            The code stops working immediately. Students already linked with it keep their pairing.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => target && revoke.mutate(target.id)}
          >
            {revoke.isPending ? "Revoking…" : "Revoke invite"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
