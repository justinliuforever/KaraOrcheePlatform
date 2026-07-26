import { z } from "zod";
import type { ApnsConfig } from "./notes/push";

export interface Config {
  databaseUrl: string;
  port: number;
  storage: { connectionString: string } | null;
  serviceBus: { connectionString: string } | null;
  auth: { tenantId: string; tenantName: string; audience: string } | null;
  apns: ApnsConfig | null;
  adminOrigins: string[];
  logAnalyticsWorkspaceId: string | null;
  // Repeat-structure pieces build and review fine, but the shipped app still assumes
  // one measure = one playback time; publishing them stays blocked until the app-side
  // repeat capability lands and this flag flips.
  appSupportsRepeats: boolean;
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(8080),
  STORAGE_CONNECTION_STRING: z.string().min(1).optional(),
  AUTH_TENANT_ID: z.string().min(1).optional(),
  AUTH_TENANT_NAME: z.string().min(1).optional(),
  AUTH_AUDIENCE: z.string().min(1).optional(),
  ADMIN_ORIGINS: z.string().optional(),
  SERVICEBUS_CONNECTION_STRING: z.string().min(1).optional(),
  LOG_ANALYTICS_WORKSPACE_ID: z.string().uuid().optional(),
  APP_SUPPORTS_REPEATS: z.enum(["true", "false"]).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_PRIVATE_KEY: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).default("com.karaorchee.karaorcheeamt"),
  APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("production"),
});

// The .p8 arrives through a shell, a JSON ARM payload and a container env var, and each
// of those hops mangles a different thing about a multi-line PEM. Base64 is the shape
// that survives all three; the literal forms are accepted so a hand-set value still works.
export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("BEGIN PRIVATE KEY")) return trimmed.replace(/\\n/g, "\n");
  return Buffer.from(trimmed, "base64").toString("utf8").trim();
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env):
  | { ok: true; config: Config }
  | { ok: false; errors: string[] } {
  const parsed = envSchema.safeParse(env);
  const errors: string[] = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return { ok: false, errors };
  }

  const e = parsed.data;

  // Auth is an all-or-nothing group: partial config fails closed at boot.
  const authVars = {
    AUTH_TENANT_ID: e.AUTH_TENANT_ID,
    AUTH_TENANT_NAME: e.AUTH_TENANT_NAME,
    AUTH_AUDIENCE: e.AUTH_AUDIENCE,
  };
  const authSet = Object.entries(authVars).filter(([, v]) => v);
  let auth: Config["auth"] = null;
  if (authSet.length > 0 && authSet.length < 3) {
    const missing = Object.entries(authVars)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    errors.push(`auth group incomplete; missing: ${missing.join(", ")}`);
  } else if (authSet.length === 3) {
    auth = {
      tenantId: e.AUTH_TENANT_ID!,
      tenantName: e.AUTH_TENANT_NAME!,
      audience: e.AUTH_AUDIENCE!,
    };
  }

  // Same all-or-nothing rule as auth: a half-set APNs group is a deployment mistake and
  // says so at boot. Wholly unset is a supported state — no key, no pushes, sends unaffected.
  const apnsVars = {
    APNS_KEY_ID: e.APNS_KEY_ID,
    APNS_TEAM_ID: e.APNS_TEAM_ID,
    APNS_PRIVATE_KEY: e.APNS_PRIVATE_KEY,
  };
  const apnsSet = Object.entries(apnsVars).filter(([, v]) => v);
  let apns: Config["apns"] = null;
  if (apnsSet.length > 0 && apnsSet.length < 3) {
    const missing = Object.entries(apnsVars)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    errors.push(`apns group incomplete; missing: ${missing.join(", ")}`);
  } else if (apnsSet.length === 3) {
    const privateKey = normalizePrivateKey(e.APNS_PRIVATE_KEY!);
    if (!privateKey.includes("BEGIN PRIVATE KEY")) {
      errors.push("APNS_PRIVATE_KEY is not a PKCS#8 PEM (expected the .p8 text, or its base64)");
    } else {
      apns = {
        keyId: e.APNS_KEY_ID!,
        teamId: e.APNS_TEAM_ID!,
        privateKey,
        bundleId: e.APNS_BUNDLE_ID,
        environment: e.APNS_ENVIRONMENT,
      };
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      databaseUrl: e.DATABASE_URL,
      port: e.PORT,
      storage: e.STORAGE_CONNECTION_STRING
        ? { connectionString: e.STORAGE_CONNECTION_STRING }
        : null,
      serviceBus: e.SERVICEBUS_CONNECTION_STRING
        ? { connectionString: e.SERVICEBUS_CONNECTION_STRING }
        : null,
      auth,
      apns,
      adminOrigins: (e.ADMIN_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      logAnalyticsWorkspaceId: e.LOG_ANALYTICS_WORKSPACE_ID ?? null,
      appSupportsRepeats: e.APP_SUPPORTS_REPEATS === "true",
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = parseConfig(env);
  if (!result.ok) {
    console.error("Invalid configuration:");
    for (const err of result.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  return result.config;
}
