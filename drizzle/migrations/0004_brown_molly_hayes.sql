ALTER TABLE "tasks" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "run_branch" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;