import express from 'express';
import { supabase } from './supabaseClient.js';

export const productsRouter = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /products
 *
 * Query params:
 *   category   (optional) - exact category match
 *   cursor     (optional) - opaque cursor from the previous page's
 *                            `nextCursor`. Omit for the first page.
 *   limit      (optional) - page size, default 20, capped at 100
 *
 * Why the cursor is just `id`, and why that's enough:
 *
 * The page is ordered by `id DESC` (insertion order, newest first).
 * `id` is assigned once by BIGSERIAL and never changes, including
 * when a product is later updated - so "the next page is everything
 * with id < the last id you saw" is a statement that stays true no
 * matter what happens to the data in between requests:
 *
 *   - New products inserted while browsing get *larger* ids, so they
 *     land before the start of the list (page 1), never inside a
 *     page boundary you've already crossed. You won't see them
 *     retroactively inserted into a page you're past, and you won't
 *     miss them - they're simply "ahead of where you started", which
 *     is the only sane behavior for a feed sorted newest first.
 *   - Existing products being updated (price, name, etc.) doesn't
 *     change their id, so they don't move in the sort order at all.
 *     No duplicate, no skip - the row's position is fixed forever.
 *   - This is strictly better than the snapshot-timestamp design
 *     using `updated_at` as the sort/cursor key: that approach drops
 *     a product from *every future page* the instant it's updated
 *     (because the WHERE updated_at <= snapshot clause excludes it),
 *     which violates "must not miss one" the moment any edit happens
 *     to an not-yet-seen row during a session.
 *
 * There is no separate "snapshotTime" concept here because none is
 * needed: id-based keyset pagination is correct under concurrent
 * writes by construction, not by freezing a point in time and hoping
 * nothing relevant changes underneath it.
 */
productsRouter.get('/products', async (req, res) => {
  try {
    const limit = clampLimit(req.query.limit);
    const category = normalizeCategory(req.query.category);
    const cursorId = parseCursor(req.query.cursor);

    if (cursorId === 'invalid') {
      return res.status(400).json({ error: 'Invalid cursor.' });
    }

    const { data, error } = await supabase.rpc('get_products_page', {
      p_category: category,
      p_cursor_id: cursorId,
      p_limit: limit,
    });

    if (error) {
      console.error('get_products_page failed:', error);
      return res.status(500).json({ error: 'Failed to fetch products.' });
    }

    const rows = data || [];
    const totalCount = rows.length > 0 ? Number(rows[0].total_count) : await countFallback(category);

    const products = rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      price: Number(row.price),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    // Cursor is just the last row's id, base64-wrapped so it reads as
    // an opaque token to clients (and leaves room to change its
    // internal shape later without breaking the API contract).
    const nextCursor =
      products.length === limit && products.length > 0
        ? encodeCursor(products[products.length - 1].id)
        : null;

    res.json({
      products,
      pageInfo: {
        limit,
        count: products.length,
        totalCount,
        hasNextPage: nextCursor !== null,
        nextCursor,
      },
    });
  } catch (err) {
    console.error('Unexpected error in GET /products:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/** GET /categories - list of distinct categories with counts, for filter UI */
productsRouter.get('/categories', async (_req, res) => {
  const { data, error } = await supabase
    .from('category_counts')
    .select('category, product_count')
    .order('category', { ascending: true });

  if (error) {
    console.error('Failed to fetch categories:', error);
    return res.status(500).json({ error: 'Failed to fetch categories.' });
  }

  res.json({
    categories: data.map((row) => ({
      name: row.category,
      count: Number(row.product_count),
    })),
  });
});

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function clampLimit(rawLimit) {
  const n = parseInt(rawLimit, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function normalizeCategory(rawCategory) {
  if (typeof rawCategory !== 'string') return null;
  const trimmed = rawCategory.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Encodes a cursor id as an opaque base64 token. */
function encodeCursor(id) {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor token back to an id.
 * Returns: null (no cursor given = first page), a number (valid
 * cursor), or the string 'invalid' (malformed token from the client).
 */
function parseCursor(rawCursor) {
  if (typeof rawCursor !== 'string' || rawCursor.length === 0) return null;
  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
    if (typeof decoded.id !== 'number' && typeof decoded.id !== 'string') return 'invalid';
    const id = Number(decoded.id);
    if (!Number.isFinite(id)) return 'invalid';
    return id;
  } catch {
    return 'invalid';
  }
}

/**
 * Rare fallback: only hit if a page comes back with zero rows (e.g.
 * the very last, empty page, or an unknown category), in which case
 * get_products_page can't piggyback total_count on a result row.
 * Cheap because category_counts is O(1) to read.
 */
async function countFallback(category) {
  if (!category) {
    const { count } = await supabase.from('products').select('*', { count: 'exact', head: true });
    return count ?? 0;
  }
  const { data } = await supabase
    .from('category_counts')
    .select('product_count')
    .eq('category', category)
    .maybeSingle();
  return data ? Number(data.product_count) : 0;
}
