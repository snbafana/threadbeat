DELETE FROM "events"
WHERE "thread_id" IS NULL
  OR "type"::text NOT IN (
    'thread.started',
    'thread.idle',
    'thread.completed',
    'thread.failed',
    'message.created',
    'agent.started',
    'tool.started',
    'tool.completed',
    'tool.failed',
    'command.started',
    'command.stdout',
    'command.stderr',
    'command.completed',
    'command.failed',
    'sandbox.created',
    'sandbox.deleted',
    'sandbox.delete_failed',
    'repo.cloned',
    'artifact.created',
    'checkpoint.created',
    'error.raised'
  );--> statement-breakpoint
DELETE FROM "heartbeats"
WHERE "thread_id" IS NULL
  OR "message_json" IS NULL;--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeats" DROP CONSTRAINT IF EXISTS "heartbeats_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."event_type";--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('thread.started', 'thread.idle', 'thread.completed', 'thread.failed', 'message.created', 'agent.started', 'tool.started', 'tool.completed', 'tool.failed', 'command.started', 'command.stdout', 'command.stderr', 'command.completed', 'command.failed', 'sandbox.created', 'sandbox.deleted', 'sandbox.delete_failed', 'repo.cloned', 'artifact.created', 'checkpoint.created', 'error.raised');--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "type" SET DATA TYPE "public"."event_type" USING "type"::"public"."event_type";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_events_task_seq";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_heartbeats_agent_id";--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeats" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeats" ALTER COLUMN "message_json" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "task_id";--> statement-breakpoint
ALTER TABLE "heartbeats" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "heartbeats" DROP COLUMN "spec_json";--> statement-breakpoint
DROP TABLE "tasks" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."task_status";
