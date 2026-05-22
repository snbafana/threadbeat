CREATE TYPE "public"."heartbeat_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TABLE "heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"title" text NOT NULL,
	"status" "heartbeat_status" DEFAULT 'active' NOT NULL,
	"cadence_seconds" integer NOT NULL,
	"spec_json" jsonb NOT NULL,
	"last_tick_at" timestamp with time zone,
	"next_tick_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_heartbeats_agent_id" ON "heartbeats" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_heartbeats_due" ON "heartbeats" USING btree ("status","next_tick_at","created_at");