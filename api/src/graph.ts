// ok:true only when Graph confirms the user is gone — unreachable/unauthorized/rate-limited must report ok:false, never an ambiguous success.

export type GraphDeleteResult =
  | { ok: true; status: number }
  | { ok: false; reason: string };

export interface GraphIdentityClient {
  /// Never throws — every failure returns a reason string; callers report it as identityDeleted:false.
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
// ATTEMPTS is capped by a synchronous caller's wait budget — unfinished deletes fall to the tombstone, not more retries.
const ATTEMPTS = 3;
const TIMEOUT_MS = 5000;

export interface GraphClientOptions {
  fetchImpl?: typeof fetch;
  authorityHost?: string;
  graphHost?: string;
  sleep?: (ms: number) => Promise<void>;
}

// All three GRAPH_* vars must be set together (matches APNs/auth groups) — a half-set trio is an error, not "deliberately off".
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

  // Deliberately uncached — deletions are rare; a cached token would be a credential held for no reason.
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

// incomplete distinguishes "no client, decided" from "no client, misconfigured" — callers must not collapse them into the same null.
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

// Memoized only for process.env (so misconfig logs once) — an explicitly passed env always resolves fresh.
export function graphFromEnv(env?: NodeJS.ProcessEnv): GraphResolution {
  if (env) return resolve(env);
  if (envResolution === undefined) envResolution = resolve(process.env);
  return envResolution;
}

// incomplete must map to "graph_config_incomplete" (alerts) — never reuse "graph_not_configured", which the runbook teaches operators to ignore.
export function unresolvedGraphLog(resolution: GraphResolution): { kind: string; reason: string } {
  return resolution.incomplete
    ? { kind: "ciam_delete_pending", reason: "graph_config_incomplete" }
    : { kind: "ciam_delete_skipped", reason: "graph_not_configured" };
}
