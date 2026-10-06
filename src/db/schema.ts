import { boolean, index, integer, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * This app owns exactly one Postgres schema, named by APP_DB_SCHEMA (`coffee`).
 * It never creates tables outside this schema and never reads/writes a kernel
 * schema or another app's schema — see docs/MIGRATIONS.md.
 */
const appSchemaName = process.env.APP_DB_SCHEMA;
if (!appSchemaName) {
  throw new Error('APP_DB_SCHEMA is not set — see .env.example and docs/MIGRATIONS.md.');
}

export const appSchema = pgSchema(appSchemaName);

/**
 * Coffee pages — tip pages linked to a DID.
 */
export const coffeePages = appSchema.table(
  'pages',
  {
    id: text('id').primaryKey(), // page_xxx
    did: text('did').notNull().unique(), // owner DID
    handle: text('handle').notNull().unique(), // URL slug
    title: text('title').notNull(), // "Buy Ryan a coffee"
    bio: text('bio'), // short description
    avatar: text('avatar'), // image URL or emoji
    avatarAssetId: text('avatar_asset_id'), // asset_xxx from the media service (nullable — emoji stays in `avatar`)
    theme: jsonb('theme').default({}),
    paymentMethods: jsonb('payment_methods').notNull(), // { stripe: {...}, solana: {...} }
    presets: integer('presets').array().default([100, 500, 1000]), // cents: $1, $5, $10
    fundDirections: jsonb('fund_directions').default([]), // [{ id, label, description }] — configurable by page owner
    thankYouContent: text('thank_you_content'), // custom thank-you page markdown
    allowCustomAmount: boolean('allow_custom_amount').default(true),
    allowMessages: boolean('allow_messages').default(true),
    isPublic: boolean('is_public').default(true),
    fairManifest: jsonb('fair_manifest'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_coffee_pages_handle').on(table.handle),
    index('idx_coffee_pages_did').on(table.did),
  ],
);

/**
 * Tips — individual tip transactions.
 */
export const tips = appSchema.table(
  'tips',
  {
    id: text('id').primaryKey(), // tip_xxx
    pageId: text('page_id')
      .references(() => coffeePages.id)
      .notNull(),
    fromDid: text('from_did'), // null for anonymous
    fromName: text('from_name'), // display name (optional)
    amount: integer('amount').notNull(), // cents (USD) or lamports (SOL)
    currency: text('currency').notNull().default('USD'), // USD, SOL, etc.
    message: text('message'), // optional message
    fundDirection: text('fund_direction'), // which fund direction the supporter chose
    paymentMethod: text('payment_method').notNull(), // 'stripe' | 'solana'
    paymentId: text('payment_id').notNull(), // Stripe charge ID or Solana tx
    status: text('status').notNull().default('pending'), // pending, completed, failed
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_tips_page').on(table.pageId),
    index('idx_tips_status').on(table.status),
    index('idx_tips_created').on(table.createdAt),
  ],
);

export type CoffeePage = typeof coffeePages.$inferSelect;
export type NewCoffeePage = typeof coffeePages.$inferInsert;
export type Tip = typeof tips.$inferSelect;
export type NewTip = typeof tips.$inferInsert;
