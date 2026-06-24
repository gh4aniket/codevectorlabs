import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL;

// Supabase is mid-migration from anon/service_role key names to
// publishable/secret key names (legacy keys are slated for
// deprecation by end of 2026), so we accept either naming here -
// whichever pair is in your .env will work.
const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    'Missing Supabase credentials. Set SUPABASE_URL and either ' +
      'SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY (server-side, ' +
      'bypasses RLS - use this for this app) in your .env file.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});
