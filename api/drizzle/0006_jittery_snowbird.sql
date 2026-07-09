CREATE TABLE "works" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"composer" text NOT NULL,
	"catalogue" text,
	"work_type" text DEFAULT 'other' NOT NULL,
	"parent_work_id" text,
	"sort_index" integer,
	"display" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "display" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pieces" ADD COLUMN "work_id" text;--> statement-breakpoint
ALTER TABLE "pieces" ADD COLUMN "work_index" integer;--> statement-breakpoint
ALTER TABLE "pieces" ADD COLUMN "instrumentation" jsonb;--> statement-breakpoint
ALTER TABLE "pieces" ADD COLUMN "facts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_parent_work_id_works_id_fk" FOREIGN KEY ("parent_work_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pieces" ADD CONSTRAINT "pieces_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;