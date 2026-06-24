# Product Browser Backend

Express + Supabase (Postgres) backend for browsing ~200,000 products,
newest-first, with category filtering and pagination that stays
correct while data is being written concurrently.

## Setup

```bash
npm install
cp .env.example .env   # fill in SUPABASE_URL and SUPABASE_SECRET_KEY
```

In the Supabase SQL editor, run, in order:

```
sql/001_schema.sql          -- table, indexes, count-tracking, page RPC
sql/002_seed_function.sql   -- server-side row generator used by the seed script
```

Then seed the data and start the server:

```bash
npm run seed     # generates 200,000 products (~40 batched RPC calls)
npm run dev       # http://localhost:3000
```

## API

### `GET /products`

| param      | required | description                                  |
|------------|----------|-----------------------------------------------|
| `category` | no       | exact category match                          |
| `cursor`   | no       | opaque token from previous page's `nextCursor`; omit for page 1 |
| `limit`    | no       | page size, default 20, max 100                |

```json
{
  "products": [
    { "id": 199982, "name": "Sleek Backpack 4821", "category": "Outdoors",
      "price": 84.99, "createdAt": "...", "updatedAt": "..." }
  ],
  "pageInfo": {
    "limit": 20,
    "count": 20,
    "totalCount": 19842,
    "hasNextPage": true,
    "nextCursor": "eyJpZCI6MTk5OTYyfQ"
  }
}
```

Get the next page by passing `nextCursor` back as `cursor`. No other
client-side state is required - not a snapshot timestamp, not the
previous page's data, nothing. The cursor alone fully determines the
next page.

### `GET /categories`

Returns every category with its product count, for building a filter
dropdown, in O(1) per category (see "Counting" below).

---

## Why id-based keyset pagination, and a deliberate deviation from one part of the brief

The brief in this task included a fairly detailed design with concrete
SQL, sorting on `updated_at DESC, id DESC` and using a client-supplied
`snapshotTime` to bound queries. I did not implement that part as
written, because it does not actually satisfy requirement #2
("must not see the same product twice or miss one when 50 products
are added/updated mid-browse") - it satisfies it only for inserts, and
breaks it for updates. Concretely:

> Backend logic uses `WHERE updated_at <= snapshotTime`. If a product
> on a page the user hasn't reached yet gets *updated* during their
> session, its `updated_at` becomes "now" - which is later than
> `snapshotTime` - so that `WHERE` clause excludes it from every
> subsequent page for the rest of the session. The user never sees
> that product at all. That's exactly the "miss one" failure mode the
> requirement says to avoid, and it's triggered by the exact scenario
> the requirement describes (updates happening mid-browse), not an
> edge case.

There's a second, smaller issue: ties on `updated_at` are broken by
`id`, but `id` order and `updated_at` order have no guaranteed
relationship to each other (an update can touch an old, low-id row at
any time), so the sort isn't even a strict total order in the way
keyset pagination needs.

**The fix:** sort and paginate on `id` alone, not `updated_at`.
`id` is assigned once (`BIGSERIAL`) and never changes:

- New rows always get a higher id than every existing row, so they
  appear *before* page 1, not inside a page boundary you've already
  crossed. You don't see them retroactively, and you don't miss them.
- Updates to existing rows don't touch `id`, so an updated row never
  moves in the sort order, never duplicates, and never disappears.
- No snapshot timestamp is needed, because there's nothing for it to
  protect against - the cursor's correctness doesn't depend on time at
  all, only on the immutability of `id`.

This is also simpler for the client: one opaque cursor field instead
of three (`snapshotTime`, `cursorId`, `cursorUpdatedAt`) that all have
to be round-tripped correctly.

**The tradeoff:** "newest first" here means *newest by insertion*, not
"most recently changed first." If the intent was actually a
"recently active items first" feed (more like a changelog or activity
stream than a product catalog), this design isn't the right fit -
that use case genuinely wants `updated_at` as the sort key, and would
need a different correctness strategy (e.g. an immutable, monotonic
`version`/`sequence` column bumped on every write via a sequence or
trigger, rather than the wall-clock `updated_at` value itself, which
is exactly the kind of column the original design was trying and
failing to use `updated_at` as). For a product catalog - which is what
this brief describes - "newest first" reading as "newest added" is the
standard and expected interpretation, so I went with it.

## Pagination correctness, restated

- **No duplicates:** every page's query is `id < cursor`, strictly
  less than the smallest id already returned. A row can only appear in
  one page's result set, ever, regardless of what else changes in the
  table.
- **No misses:** a row keeps the same id forever, so once it exists in
  the table, exactly one page boundary will include it, and that
  doesn't change based on timing.
- **New rows never break an in-progress scroll:** they land with ids
  higher than the current max, i.e. "ahead" of where the user started,
  which is the only place that makes sense for a newest-first feed.

## Performance

- `WHERE id < $cursor ORDER BY id DESC LIMIT n` is satisfied directly
  by the primary key's btree - no separate index needed, and the cost
  is `O(limit)`, not `O(offset + limit)` like `OFFSET`-based paging.
  This is what keeps page 9,000 exactly as fast as page 1.
- The category-filtered version uses a dedicated composite index,
  `(category, id desc)`, so `WHERE category = X AND id < cursor ORDER
  BY id DESC` is also a direct index range scan.
- **Counting is the part that's easy to get wrong at this scale.**
  `SELECT count(*) FROM products WHERE category = X` is a full scan of
  every matching row under Postgres's MVCC visibility rules - indexes
  don't make `count(*)` itself fast, only finding the rows to count.
  Rendering that on every single page request would quietly undercut
  "fast pagination," so category counts are tracked incrementally in a
  `category_counts` table via triggers (`sql/001_schema.sql`), making
  a count lookup O(1) regardless of table size. The one remaining
  exception is the *unfiltered* total (all categories combined), which
  still runs a live `count(*)` for simplicity - call this out
  explicitly if unfiltered traffic at meaningful scale matters for
  your use case; the fix is the same pattern (a single running total
  row, or `sum(product_count)` over `category_counts`).
- The page RPC (`get_products_page`) is a single Postgres function
  called via `supabase.rpc(...)`, so each page fetch is one network
  round trip and one fixed, plan-cached query shape - not several
  chained `.eq()/.lt()` query-builder calls that PostgREST would have
  to assemble dynamically.

## Seeding

`scripts/seed.js` is the committed entry point, but the actual row
construction happens in `seed_products_batch` (`sql/002_seed_function.sql`),
run via `INSERT ... SELECT generate_series(...)` entirely inside
Postgres. The Node script just calls that function 40 times (5,000 rows
each by default) and reports progress. This avoids both: looping
200,000 individual `.insert()` calls (200,000 HTTP round trips), and
building 200,000 JS objects to ship as one huge JSON payload (still
pays full network transfer for data that never needed to leave the
database). Tune batch size with `node scripts/seed.js --batch=2000` or
total rows with `--count=50000`.
