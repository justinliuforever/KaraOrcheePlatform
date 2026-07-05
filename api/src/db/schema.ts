import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  entraOid: text("entra_oid").notNull().unique(),
  email: text("email").unique(),
  displayName: text("display_name"),
  isTeacher: boolean("is_teacher").notNull().default(false),
  isStudent: boolean("is_student").notNull().default(false),
  referredBy: uuid("referred_by").references((): AnyPgColumn => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
