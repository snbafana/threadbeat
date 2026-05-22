CREATE TYPE "public"."message_role" AS ENUM('human', 'agent', 'heartbeat');--> statement-breakpoint
CREATE TYPE "public"."thread_status" AS ENUM('queued', 'running', 'idle', 'paused', 'completed', 'failed', 'archived');--> statement-breakpoint
ALTER TYPE "public"."heartbeat_status" ADD VALUE 'disabled';--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"kind" text NOT NULL,
	"uri" text NOT NULL,
	"content_type" text,
	"sha256" text,
	"size_bytes" integer,
	"summary_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"role" "message_role" NOT NULL,
	"content_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"idle_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"index" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" "thread_status" DEFAULT 'queued' NOT NULL,
	"agent_id" text,
	"goal_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeats" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeats" ALTER COLUMN "spec_json" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD COLUMN "message_json" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifacts_thread_created_at" ON "artifacts" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_artifacts_kind" ON "artifacts" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_messages_thread_created_at" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sandboxes_thread_index" ON "sandboxes" USING btree ("thread_id","index");--> statement-breakpoint
CREATE INDEX "idx_sandboxes_thread_created_at" ON "sandboxes" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_threads_agent_id" ON "threads" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_threads_status_updated_at" ON "threads" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_events_thread_seq" ON "events" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "idx_heartbeats_thread_id" ON "heartbeats" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_thread_id" ON "tasks" USING btree ("thread_id");