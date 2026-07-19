CREATE TABLE "composers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_name" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"birth_year" integer,
	"death_year" integer,
	"bio" text,
	"portrait_path" text,
	"attribution" text,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "composers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "piece_count" integer;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "movement_count" integer;