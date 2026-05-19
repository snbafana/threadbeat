ALTER TABLE "events" DROP CONSTRAINT "events_run_id_runs_id_fk";
--> statement-breakpoint
DROP INDEX "idx_events_run_seq";--> statement-breakpoint
UPDATE "events"
SET "data_json" = COALESCE("data_json", '{}'::jsonb) || CASE
  WHEN "type" = 'command_stdout' THEN jsonb_build_object('stdout', "message")
  WHEN "type" = 'command_started' THEN jsonb_build_object('cmd', "message")
  WHEN "type" = 'command_finished' THEN jsonb_build_object('result', "message")
  WHEN "type" IN ('run_failed', 'sandbox_delete_failed') THEN jsonb_build_object('error', "message")
  ELSE jsonb_build_object('message', "message")
END
WHERE "message" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "run_id";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "message";--> statement-breakpoint
DROP TABLE "runs";
