CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repo_url" text NOT NULL,
	"default_branch" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "agent_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "run_branch" text;--> statement-breakpoint
DO $$
BEGIN
	ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk"
		FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
		ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
