CREATE TYPE "public"."event_type" AS ENUM('task.created', 'task.leased', 'task.started', 'task.completed', 'task.failed', 'task.cancelled', 'task.expired', 'message.created', 'model.started', 'model.delta', 'model.completed', 'tool.started', 'tool.completed', 'tool.failed', 'command.started', 'command.stdout', 'command.stderr', 'command.completed', 'command.failed', 'sandbox.created', 'sandbox.deleted', 'sandbox.delete_failed', 'repo.cloned', 'artifact.created', 'checkpoint.created', 'error.raised');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'claimed', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'expired');--> statement-breakpoint
UPDATE "events"
SET "type" = CASE "type"
  WHEN 'task_created' THEN 'task.created'
  WHEN 'run_started' THEN 'task.started'
  WHEN 'run_succeeded' THEN 'task.completed'
  WHEN 'run_failed' THEN 'task.failed'
  WHEN 'sandbox_created' THEN 'sandbox.created'
  WHEN 'sandbox_deleted' THEN 'sandbox.deleted'
  WHEN 'sandbox_delete_failed' THEN 'sandbox.delete_failed'
  WHEN 'repo_cloned' THEN 'repo.cloned'
  WHEN 'command_started' THEN 'command.started'
  WHEN 'command_stdout' THEN 'command.stdout'
  WHEN 'command_finished' THEN 'command.completed'
  ELSE "type"
END;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "type" SET DATA TYPE "public"."event_type" USING "type"::"public"."event_type";--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" SET DATA TYPE "public"."task_status" USING "status"::"public"."task_status";
