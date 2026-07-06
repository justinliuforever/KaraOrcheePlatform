import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Deletion is soft (5.1.1(v)/GDPR): erase scrubs email/display_name/entra_oid, keeps the row
// so financial and referral history stays intact.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  entraOid: text("entra_oid").unique(),
  email: text("email").unique(),
  displayName: text("display_name"),
  isTeacher: boolean("is_teacher").notNull().default(false),
  isStudent: boolean("is_student").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  status: text("status").notNull().default("active"), // active | deleted
  referredBy: uuid("referred_by").references((): AnyPgColumn => users.id),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A method book / pedagogical collection pieces can belong to. rights gates publish.
export const books = pgTable("books", {
  id: text("id").primaryKey(), // slug, e.g. czerny_op599
  title: text("title").notNull(),
  author: text("author"),
  publisher: text("publisher"),
  edition: text("edition"),
  coverPath: text("cover_path"), // container-relative blob path
  rights: text("rights").notNull().default("unknown"), // public_domain | licensed | unknown | blocked
  rightsNote: text("rights_note"),
  sortIndex: integer("sort_index"),
  status: text("status").notNull().default("active"), // active | archived
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// SQL is the catalog truth; catalog.json is a build artifact regenerated on publish.
export const pieces = pgTable("pieces", {
  id: text("id").primaryKey(), // asset slug, e.g. bach_bwv_846
  title: text("title").notNull(),
  composer: text("composer").notNull(),
  subtitle: text("subtitle").notNull().default(""),
  mode: text("mode").notNull().default("solo"), // solo | concerto
  difficulty: integer("difficulty"), // 1..5 student-facing
  tracking: text("tracking").notNull().default("experimental"), // validated | experimental
  tags: jsonb("tags").notNull().default([]),
  display: jsonb("display").notNull().default({}),
  bookId: text("book_id").references(() => books.id),
  bookIndex: integer("book_index"),
  rights: text("rights").notNull().default("unknown"), // public_domain | licensed | unknown | blocked
  rightsNote: text("rights_note"),
  status: text("status").notNull().default("draft"), // draft | published | archived
  publishedVersion: integer("published_version"), // pointer, set transactionally at publish
  thumbnailPath: text("thumbnail_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Immutable: one row per built bundle version. files[] stores container-RELATIVE paths
// ({role, variant?, path, bytes, sha256}); SAS-signed URLs are minted at read time.
export const pieceVersions = pgTable(
  "piece_versions",
  {
    pieceId: text("piece_id")
      .notNull()
      .references(() => pieces.id),
    version: integer("version").notNull(),
    engineSha: text("engine_sha"),
    files: jsonb("files").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    publishedBy: uuid("published_by").references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.pieceId, t.version] })],
);

export type User = typeof users.$inferSelect;
export type Piece = typeof pieces.$inferSelect;
export type Book = typeof books.$inferSelect;
