import { Router } from "express";
import multer from "multer";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../deps";
import { wrap } from "../deps";
import { requireAuth } from "../auth";
import { requireAdmin, audit } from "../admin";
import { composers, pieces, works } from "../db/schema";
import { processPortrait, CoverError } from "../covers";
import { slugify } from "../slug";
import { rebuildCatalog } from "../catalog_build";

// Registry entries join pieces/works by STRING (name or alias) at read time —
// deliberately lean, no foreign keys. Deleting one never touches content.
const composerSchema = z.object({
  name: z.string().min(1).max(120),
  sortName: z.string().max(120).nullable().optional(),
  aliases: z.array(z.string().min(1).max(120)).max(50).optional(),
  birthYear: z.number().int().min(1000).max(9999).nullable().optional(),
  deathYear: z.number().int().min(1000).max(9999).nullable().optional(),
  bio: z.string().max(4000).nullable().optional(),
  attribution: z.string().max(2000).nullable().optional(),
  sourceUrl: z.string().url().max(500).nullable().optional(),
});

const portraitUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

interface UsageRow {
  value: string;
  pieceCount: number;
  workCount: number;
}

export function composersRouter(deps: Deps): Router {
  const router = Router();
  router.use("/admin/composers", requireAuth(deps.auth), requireAdmin(deps));

  function signPortrait(path: string | null): string | null {
    if (!path || !deps.studio || !deps.catalog) return null;
    return deps.catalog.signReadUrl(deps.studio.bundleUrl(path));
  }

  async function distinctComposerStrings(db: NonNullable<Deps["db"]>["orm"]): Promise<UsageRow[]> {
    const pieceCounts = await db
      .select({ value: pieces.composer, count: sql<number>`count(*)::int` })
      .from(pieces)
      .groupBy(pieces.composer);
    const workCounts = await db
      .select({ value: works.composer, count: sql<number>`count(*)::int` })
      .from(works)
      .groupBy(works.composer);
    const byValue = new Map<string, UsageRow>();
    for (const r of pieceCounts) {
      byValue.set(r.value, { value: r.value, pieceCount: r.count, workCount: 0 });
    }
    for (const r of workCounts) {
      const row = byValue.get(r.value) ?? { value: r.value, pieceCount: 0, workCount: 0 };
      row.workCount = r.count;
      byValue.set(r.value, row);
    }
    return [...byValue.values()].sort((a, b) => a.value.localeCompare(b.value));
  }

  router.get(
    "/admin/composers",
    wrap(async (_req, res) => {
      const db = deps.db!.orm;
      const rows = await db.select().from(composers).orderBy(composers.name);
      const usage = await distinctComposerStrings(db);

      // Name matches take priority over alias matches — a string maps to ONE entry.
      const strings = usage.map((u) => {
        const byName = rows.find((r) => r.name === u.value);
        const byAlias = byName ? undefined : rows.find((r) => (r.aliases as string[]).includes(u.value));
        const hit = byName ?? byAlias;
        return {
          ...u,
          composerId: hit?.id ?? null,
          composerName: hit?.name ?? null,
          matched: byName ? ("name" as const) : byAlias ? ("alias" as const) : null,
        };
      });

      const items = rows.map((r) => ({
        ...r,
        portraitUrl: signPortrait(r.portraitPath),
        // Usage = pieces whose composer string is the name OR any alias.
        usageCount: strings
          .filter((s) => s.composerId === r.id)
          .reduce((sum, s) => sum + s.pieceCount, 0),
      }));

      res.json({ items, strings, unregistered: strings.filter((s) => s.composerId === null) });
    }),
  );

  router.post(
    "/admin/composers",
    wrap(async (req, res) => {
      const parsed = composerSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_composer", detail: parsed.error.issues });
        return;
      }
      const db = deps.db!.orm;
      const c = parsed.data;
      const id = slugify(c.name).slice(0, 64).replace(/_+$/, "");
      if (!id) {
        res.status(400).json({ error: "invalid_composer", detail: "name yields an empty id" });
        return;
      }
      const [existing] = await db.select().from(composers).where(eq(composers.id, id)).limit(1);
      if (existing) {
        res.status(409).json({ error: "composer_exists", composer: existing });
        return;
      }
      const [sameName] = await db.select().from(composers).where(eq(composers.name, c.name)).limit(1);
      if (sameName) {
        res.status(409).json({ error: "composer_exists", composer: sameName });
        return;
      }
      const [row] = await db
        .insert(composers)
        .values({
          id,
          name: c.name,
          sortName: c.sortName ?? null,
          aliases: c.aliases ?? [],
          birthYear: c.birthYear ?? null,
          deathYear: c.deathYear ?? null,
          bio: c.bio ?? null,
          attribution: c.attribution ?? null,
          sourceUrl: c.sourceUrl ?? null,
        })
        .returning();
      // A new entry may match already-published pieces — the catalog gains it now.
      if (deps.studio) await rebuildCatalog(db, deps.studio);
      await audit(deps, req, "composer.create", { type: "composer", id });
      res.status(201).json({ ...row, portraitUrl: null });
    }),
  );

  router.patch(
    "/admin/composers/:id",
    wrap(async (req, res) => {
      const parsed = composerSchema.partial().safeParse(req.body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        res.status(400).json({ error: "invalid_composer", ...(parsed.success ? {} : { detail: parsed.error.issues }) });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [existing] = await db.select().from(composers).where(eq(composers.id, id)).limit(1);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const updates: typeof parsed.data = { ...parsed.data };
      if (parsed.data.name && parsed.data.name !== existing.name) {
        const [clash] = await db
          .select()
          .from(composers)
          .where(eq(composers.name, parsed.data.name))
          .limit(1);
        if (clash && clash.id !== id) {
          res.status(409).json({ error: "composer_exists", composer: clash });
          return;
        }
        // Rename propagation: pieces/works keep denormalized composer strings with
        // no FK — the old name auto-joins the aliases (deduped, new name stripped)
        // or every existing piece string would orphan out of the catalog join.
        const base = parsed.data.aliases ?? (existing.aliases as string[]);
        updates.aliases = [...new Set([...base, existing.name])].filter(
          (a) => a !== parsed.data.name,
        );
      }
      const [row] = await db
        .update(composers)
        .set({ ...updates, updatedAt: sql`now()` })
        .where(eq(composers.id, id))
        .returning();
      // Name/alias edits change which published pieces match — rebuild like works do.
      if (deps.studio) await rebuildCatalog(db, deps.studio);
      await audit(deps, req, "composer.update", { type: "composer", id }, { changes: updates });
      res.json({ ...row!, portraitUrl: signPortrait(row!.portraitPath) });
    }),
  );

  router.delete(
    "/admin/composers/:id",
    wrap(async (req, res) => {
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [existing] = await db.select().from(composers).where(eq(composers.id, id)).limit(1);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // No usage guard on purpose: the registry only decorates strings that keep
      // living on pieces/works — deleting an entry can never take content down.
      await db.delete(composers).where(eq(composers.id, id));
      if (existing.portraitPath && deps.studio?.deleteBundleBlob) {
        await deps.studio.deleteBundleBlob(existing.portraitPath);
      }
      if (deps.studio) await rebuildCatalog(db, deps.studio);
      await audit(deps, req, "composer.delete", { type: "composer", id }, { name: existing.name });
      res.json({ ok: true });
    }),
  );

  router.put(
    "/admin/composers/:id/portrait",
    portraitUpload.single("portrait"),
    wrap(async (req, res) => {
      if (!deps.studio) {
        res.status(503).json({ error: "studio_not_configured" });
        return;
      }
      const db = deps.db!.orm;
      const id = String(req.params.id);
      const [existing] = await db.select().from(composers).where(eq(composers.id, id)).limit(1);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "portrait_required" });
        return;
      }
      let portrait: Buffer;
      try {
        portrait = await processPortrait(req.file.buffer);
      } catch (err) {
        if (err instanceof CoverError) {
          res.status(400).json({ error: "invalid_portrait", message: err.message });
          return;
        }
        throw err;
      }
      const portraitPath = `composers/${id}/portrait.webp`;
      await deps.studio.putBundleBlob(portraitPath, portrait, "image/webp");
      const [row] = await db
        .update(composers)
        .set({ portraitPath, updatedAt: sql`now()` })
        .where(eq(composers.id, id))
        .returning();
      // First portrait changes the emitted portrait_url; same-path replacements
      // need no rebuild — the URL is unchanged and signed per request.
      if (!existing.portraitPath) await rebuildCatalog(db, deps.studio);
      await audit(deps, req, "composer.set_portrait", { type: "composer", id });
      res.json({ ...row!, portraitUrl: signPortrait(portraitPath) });
    }),
  );

  return router;
}
