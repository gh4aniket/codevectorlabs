/**
 * scripts/seed.js
 *
 * Generates ~200,000 products in Supabase Postgres.
 *
 * Approach: each batch's actual row construction happens inside
 * Postgres (see sql/002_seed_function.sql, seed_products_batch),
 * not in this script. This script just fires the batches and reports
 * progress. That split is the "don't do a slow approach in a loop"
 * fix - 40 RPC calls of 5000 rows each, instead of either:
 *   (a) 200,000 individual .insert() calls (extremely slow: network +
 *       HTTP overhead per row), or
 *   (b) building 200,000 JS objects and shipping them as one giant
 *       JSON payload over HTTP (memory-heavy, slow to serialize, and
 *       still pays full network transfer for data that never needed
 *       to leave the database).
 *
 * Usage:
 *   node scripts/seed.js                 # seeds 200,000 products
 *   node scripts/seed.js --count=50000   # seed a smaller amount
 *   node scripts/seed.js --batch=2000    # change batch size
 */

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const TOTAL = parseInt(argValue('count', '200000'), 10);
const BATCH_SIZE = parseInt(argValue('batch', '5000'), 10);

function argValue(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : fallback;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
// Seeding needs to bypass RLS and call an admin-ish RPC, so this must
// be the secret/service-role key, never the publishable/anon key.
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) in .env'
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log(`Seeding ${TOTAL} products in batches of ${BATCH_SIZE}...`);
  const start = Date.now();

  let remaining = TOTAL;
  let offset = 0;
  let batchNum = 0;

  while (remaining > 0) {
    const thisBatch = Math.min(BATCH_SIZE, remaining);
    batchNum += 1;

    const { error } = await supabase.rpc('seed_products_batch', {
      p_count: thisBatch,
      p_start_offset: offset,
    });

    if (error) {
      console.error(`Batch ${batchNum} failed:`, error.message);
      process.exit(1);
    }

    offset += thisBatch;
    remaining -= thisBatch;

    const done = TOTAL - remaining;
    const pct = ((done / TOTAL) * 100).toFixed(1);
    console.log(`  batch ${batchNum}: +${thisBatch} rows  (${done}/${TOTAL}, ${pct}%)`);
  }

  // Backfill category_counts in case this is a fresh seed and the
  // table didn't exist when earlier rows were inserted by some other
  // path. Cheap no-op if triggers already kept it in sync.
  const { error: rebuildError } = await supabase.rpc('rebuild_category_counts');
  if (rebuildError) {
    console.warn('Warning: rebuild_category_counts failed:', rebuildError.message);
  }

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done. Seeded ${TOTAL} products in ${seconds}s.`);
}

main();
