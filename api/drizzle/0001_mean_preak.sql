CREATE TABLE "books" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"publisher" text,
	"edition" text,
	"cover_path" text,
	"rights" text DEFAULT 'unknown' NOT NULL,
	"rights_note" text,
	"sort_index" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "piece_versions" (
	"piece_id" text NOT NULL,
	"version" integer NOT NULL,
	"engine_sha" text,
	"files" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	CONSTRAINT "piece_versions_piece_id_version_pk" PRIMARY KEY("piece_id","version")
);
--> statement-breakpoint
CREATE TABLE "pieces" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"composer" text NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"mode" text DEFAULT 'solo' NOT NULL,
	"difficulty" integer,
	"tracking" text DEFAULT 'experimental' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"display" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"book_id" text,
	"book_index" integer,
	"rights" text DEFAULT 'unknown' NOT NULL,
	"rights_note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_version" integer,
	"thumbnail_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "entra_oid" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "piece_versions" ADD CONSTRAINT "piece_versions_piece_id_pieces_id_fk" FOREIGN KEY ("piece_id") REFERENCES "public"."pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "piece_versions" ADD CONSTRAINT "piece_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pieces" ADD CONSTRAINT "pieces_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;