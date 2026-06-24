import express from 'express';
import { supabase } from './supabaseClient.js';

export const productsRouter = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

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
