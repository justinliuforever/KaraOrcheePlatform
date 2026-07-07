import { z } from "zod";

export interface Config {
  databaseUrl: string;
  port: number;
  storage: { connectionString: string } | null;
  serviceBus: { connectionString: string } | null;
  auth: { tenantId: string; tenantName: string; audience: string } | null;
  adminOrigins: string[];
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
});

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
      adminOrigins: (e.ADMIN_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
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
