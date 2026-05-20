CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repo_url" text NOT NULL,
	"default_branch" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;