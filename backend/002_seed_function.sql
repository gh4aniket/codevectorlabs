-- =====================================================================
-- Seed function: generates ~200,000 realistic products, in batches,
-- entirely inside Postgres.
--
-- Why server-side generation instead of looping in Node and calling
-- .insert() 200,000 times (or even in JS-built batches of 5000):
--   - Each .insert() call from supabase-js is an HTTP round trip to
--     PostgREST. Even batched at 5000 rows/request that's 40 requests,
--     each paying network + HTTP + JSON (de)serialization overhead for
--     a payload that doesn't need to leave the database at all.
--   - generate_series + INSERT ... SELECT runs entirely in the
--     database's own memory space, no serialization, no network hop
--     per batch - this is the actual fast approach the assignment's
--     "don't do a slow approach in a loop" tip is pointing at, taken
--     to its conclusion.
--   - It's still called from the seed script (scripts/seed.js) via a
--     single supabase.rpc() call per batch, so the seed script
--     remains the auditable, committed entry point requested by the
--     assignment - it just delegates the actual row construction to
--     SQL instead of building 5000 JS objects and shipping them over
--     the wire.
-- =====================================================================

create or replace function seed_products_batch(
    p_count       int,
    p_start_offset bigint    -- used only to vary created_at spread across batches
)
returns void
language sql
as $$
    insert into products (name, category, price, created_at, updated_at)
    select
        -- "<Adjective> <Noun> <Number>" reads like a real catalog name
        -- (e.g. "Sleek Backpack 4821") without needing a names table.
        initcap(adjectives.word) || ' ' || initcap(nouns.word) || ' ' ||
            (1000 + (random() * 8999)::int)::text,
        categories.word,
        -- price: 4.99 to 999.99, skewed toward cheaper items like a
        -- real catalog (squaring a uniform pulls the mass down low).
        round((4.99 + power(random(), 2) * 995)::numeric, 2),
        -- spread created_at over the past ~2 years, newer batches
        -- biased slightly more recent so "newest first" has a real
        -- distribution to page through.
        now() - (random() * interval '730 days')
            - (p_start_offset / 1000.0) * interval '1 second',
        now() - (random() * interval '730 days')
            - (p_start_offset / 1000.0) * interval '1 second'
    from
        generate_series(1, p_count) as g(n)
        cross join lateral (
            select (array['Sleek','Rustic','Modern','Classic','Premium',
                'Compact','Heavy-Duty','Eco', 'Smart','Vintage','Bold',
                'Minimal'])[1 + floor(random()*12)::int] as word
        ) as adjectives
        cross join lateral (
            select (array['Backpack','Chair','Lamp','Bottle','Jacket',
                'Headphones','Keyboard','Mug','Desk','Speaker','Wallet',
                'Sneakers','Monitor','Blanket','Charger','Tent'])
                [1 + floor(random()*16)::int] as word
        ) as nouns
        cross join lateral (
            select (array['Electronics','Home & Kitchen','Outdoors',
                'Apparel','Office Supplies','Sports','Toys','Beauty',
                'Books','Automotive'])[1 + floor(random()*10)::int] as word
        ) as categories;
$$;

comment on function seed_products_batch is
    'Generates p_count random-but-realistic products in one INSERT ...
     SELECT, server-side. Called repeatedly with p_count=5000 by
     scripts/seed.js to build up to 200,000 rows without any
     per-row network round trip.';
