

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const TOTAL = parseInt(argValue('count', '200000'), 10);
const BATCH_SIZE = parseInt(argValue('batch', '5000'), 10);

function argValue(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : fallback;
}

const SUPABASE_URL = process.env.SUPABASE_URL;

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

  
  const { error: rebuildError } = await supabase.rpc('rebuild_category_counts');
  if (rebuildError) {
    console.warn('Warning: rebuild_category_counts failed:', rebuildError.message);
  }

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done. Seeded ${TOTAL} products in ${seconds}s.`);
}

main();
