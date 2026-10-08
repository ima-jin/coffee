ALTER TABLE "coffee"."tips" ADD COLUMN "pay_transaction_id" text;--> statement-breakpoint
ALTER TABLE "coffee"."tips" ADD COLUMN "payee_manifest" jsonb;--> statement-breakpoint
ALTER TABLE "coffee"."tips" ADD COLUMN "settled_at" timestamp with time zone;