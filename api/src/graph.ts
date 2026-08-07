// Microsoft Graph, app-only, for exactly one operation: removing a deleted account's
// sign-in identity from the Auth tenant.
//
// HONESTY RULE, BINDING: this module reports success only when a Graph call actually
// answered that the user is gone. Unconfigured, unreachable, unauthorized and
// rate-limited all report failure, because the delete sheet turns this answer into a
// sentence a person reads. "We could not tell" is never "we removed it".

export type GraphDeleteResult =
  | { ok: true; status: number }
  | { ok: false; reason: string };

export interface GraphIdentityClient {
  /// Removes a directory user by object id. Never throws: every failure is a reason
  /// string the caller logs and reports as identityDeleted:false.
  deleteUser(oid: string): Promise<GraphDeleteResult>;
}

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

const AUTHORITY_HOST = "https://login.microsoftonline.com";
const GRAPH_HOST = "https://graph.microsoft.com";
const SCOPE = "https://graph.microsoft.com/.default";
// A person is waiting on the delete response; three tries with a short backoff is the
// most that fits under that, and the tombstone carries whatever this does not finish.
const ATTEMPTS = 3;
const TIMEOUT_MS = 5000;

export interface GraphClientOptions {
  fetchImpl?: typeof fetch;
  authorityHost?: string;
  graphHost?: string;
  sleep?: (ms: number) => Promise<void>;
}

// The trio is all-or-nothing, matching the APNs/auth groups: a half-set group is a
// deployment mistake and must not read as "deliberately off".
export function graphConfigFrom(env: NodeJS.ProcessEnv):
  | { ok: true; config: GraphConfig | null }
  | { ok: false; missing: string[] } {
  const vars = {
    GRAPH_TENANT_ID: env.GRAPH_TENANT_ID,
    GRAPH_CLIENT_ID: env.GRAPH_CLIENT_ID,
    GRAPH_CLIENT_SECRET: env.GRAPH_CLIENT_SECRET,
  };
  const set = Object.entries(vars).filter(([, v]) => v && v.length > 0);
  if (set.length === 0) return { ok: true, config: null };
  if (set.length < 3) {
    return { ok: false, missing: Object.entries(vars).filter(([, v]) => !v).map(([k]) => k) };
  }
  return {
    ok: true,
    config: {
      tenantId: vars.GRAPH_TENANT_ID!,
      clientId: vars.GRAPH_CLIENT_ID!,
      clientSecret: vars.GRAPH_CLIENT_SECRET!,
    },
  };
}

export function createGraphClient(
  config: GraphConfig,
  opts: GraphClientOptions = {},
): GraphIdentityClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const authorityHost = opts.authorityHost ?? AUTHORITY_HOST;
  const graphHost = opts.graphHost ?? GRAPH_HOST;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Deliberately uncached: an account deletion is rare, and a token cached across one
  // is a credential held for no reason.
  async function accessToken(): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: SCOPE,
      grant_type: "client_credentials",
    });
    const res = await withTimeout((signal) =>
      doFetch(`${authorityHost}/${config.tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal,
      }));
    if (!res.ok) return { ok: false, reason: `token_http_${res.status}` };
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) return { ok: false, reason: "token_missing" };
    return { ok: true, token: json.access_token };
  }

  async function withTimeout(run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function attempt(oid: string): Promise<GraphDeleteResult> {
    const token = await accessToken();
    if (!token.ok) return token;
    const res = await withTimeout((signal) =>
      doFetch(`${graphHost}/v1.0/users/${encodeURIComponent(oid)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token.token}` },
        signal,
      }));
    // 404 is success: the directory object is not there, which is the whole point.
    if (res.status === 404 || (res.status >= 200 && res.status < 300)) {
      return { ok: true, status: res.status };
    }
    return { ok: false, reason: `graph_http_${res.status}` };
  }

  return {
    async deleteUser(oid: string): Promise<GraphDeleteResult> {
      let last: GraphDeleteResult = { ok: false, reason: "no_attempt" };
      for (let i = 1; i <= ATTEMPTS; i++) {
        try {
          last = await attempt(oid);
        } catch (err) {
          last = { ok: false, reason: err instanceof Error ? err.name : "unknown_error" };
        }
        if (last.ok) return last;
        if (i < ATTEMPTS) await sleep(250 * i);
      }
      return last;
    },
  };
}

// No client, and WHY: a trio nobody set is a decision, a trio half-set is a deployment
// mistake. The caller prints those two differently, so it may not be handed the same null.
export interface GraphResolution {
  client: GraphIdentityClient | null;
  incomplete: boolean;
}

function resolve(env: NodeJS.ProcessEnv): GraphResolution {
  const parsed = graphConfigFrom(env);
  if (!parsed.ok) {
    console.log(JSON.stringify({ kind: "graph_config_incomplete", missing: parsed.missing }));
    return { client: null, incomplete: true };
  }
  return { client: parsed.config ? createGraphClient(parsed.config) : null, incomplete: false };
}

let envResolution: GraphResolution | undefined;

// Resolved once per process, so a misconfiguration is logged once rather than per request.
// An explicitly passed env is always read fresh — the memo is about the container's own
// environment, and a caller naming another one is asking about that one.
export function graphFromEnv(env?: NodeJS.ProcessEnv): GraphResolution {
  if (env) return resolve(env);
  if (envResolution === undefined) envResolution = resolve(process.env);
  return envResolution;
}

// A half-set trio is unfinished work: it must reach the alert, and it must not carry the
// reason string the runbook teaches operators to ignore.
export function unresolvedGraphLog(resolution: GraphResolution): { kind: string; reason: string } {
  return resolution.incomplete
    ? { kind: "ciam_delete_pending", reason: "graph_config_incomplete" }
    : { kind: "ciam_delete_skipped", reason: "graph_not_configured" };
}
