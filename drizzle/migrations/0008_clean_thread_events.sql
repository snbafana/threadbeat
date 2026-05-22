ALTER TABLE "events" DROP COLUMN IF EXISTS "run_id";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN IF EXISTS "message";--> statement-breakpoint
UPDATE "heartbeats"
SET "next_tick_at" = now()
WHERE "next_tick_at" IS NULL;--> statement-breakpoint
ALTER TABLE "heartbeats" ALTER COLUMN "next_tick_at" SET NOT NULL;
