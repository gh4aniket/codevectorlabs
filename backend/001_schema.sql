-- =====================================================================
-- Schema for product browsing service
-- Run this in the Supabase SQL editor (or via `supabase db push` / psql
-- against your Supabase connection string). This is the only migration
-- needed for the assignment.
-- =====================================================================

create table if not exists products (
    id          bigserial primary key,
    name        text           not null,
    category    text           not null,
    price       numeric(10,2)  not null,
    created_at  timestamptz    not null default now(),
    updated_at  timestamptz    not null default now()
);

-- ---------------------------------------------------------------------
-- Indexes
--
-- IMPORTANT: pagination in this design is keyset-on-`id`, NOT on
-- updated_at. See README.md "Why id and not updated_at" for the full
-- reasoning. updated_at is kept as a normal display/audit column and
-- is indexed only because product listings/search UIs commonly want
-- to sort/filter "recently changed" items - it plays no role in making
-- pagination correct.
-- ---------------------------------------------------------------------

-- Primary browse order: newest-inserted-first, globally.
-- id DESC with no other predicate is satisfied directly by the PK's
-- btree (ids are monotonic), but we still want it explicit/cheap for
-- "WHERE id < $cursor ORDER BY id DESC" - the PK index already covers
-- this perfectly, so no extra index is required for the unfiltered case.

-- Category-filtered browse order: this is the one that needs a
-- dedicated composite index, since the PK index alone can't satisfy
-- "WHERE category = X AND id < cursor ORDER BY id DESC" efficiently.
create index if not exists idx_products_category_id
    on products (category, id desc);

-- Optional: lets the UI show "recently updated" without touching the
-- pagination path.
create index if not exists idx_products_updated_at
    on products (updated_at desc);

-- ---------------------------------------------------------------------
-- Category counts (for "total items in this category" in the UI)
--
-- A plain `select count(*) from products where category = X` is a full
-- index scan over every matching row - on 200k rows that's the kind of
-- thing that quietly makes "fast pagination at large page numbers" a
-- lie, since people often render the count on every page. We maintain
-- a tiny summary table with triggers instead, so reading a count is
-- O(1) regardless of table size. This is the standard Postgres
-- pattern for exact counts at scale (the alternative, reltuples from
-- pg_class, is fast but only approximate).
-- ---------------------------------------------------------------------

create table if not exists category_counts (
    category       text primary key,
    product_count  bigint not null default 0
);

create or replace function _category_counts_sync() returns trigger
language plpgsql as $$
begin
    if tg_op = 'INSERT' then
        insert into category_counts (category, product_count)
        values (new.category, 1)
        on conflict (category)
        do update set product_count = category_counts.product_count + 1;

    elsif tg_op = 'DELETE' then
        update category_counts
        set product_count = product_count - 1
        where category = old.category;

    elsif tg_op = 'UPDATE' and new.category <> old.category then
        update category_counts
        set product_count = product_count - 1
        where category = old.category;

        insert into category_counts (category, product_count)
        values (new.category, 1)
        on conflict (category)
        do update set product_count = category_counts.product_count + 1;
    end if;
    return null;
end;
$$;

drop trigger if exists trg_category_counts on products;
create trigger trg_category_counts
    after insert or update or delete on products
    for each row execute function _category_counts_sync();

-- One-time backfill helper. The seed script's batch inserts go
-- through the trigger above automatically, so this is only needed if
-- you ever load data by some other path (e.g. a raw CSV COPY).
create or replace function rebuild_category_counts() returns void
language sql as $$
    truncate category_counts;
    insert into category_counts (category, product_count)
    select category, count(*) from products group by category;
$$;

-- ---------------------------------------------------------------------
-- RPC: keyset page fetch
--
-- supabase-js's query builder can't express the compound
-- "id < cursor" tie-break safely once you add filters, and more
-- importantly we want the planner to use one fixed, well-indexed
-- query shape rather than dynamically chained .lt()/.eq() calls.
-- A SQL function called over PostgREST's rpc() gives us exactly one
-- round trip and one query plan. Total count comes from the summary
-- table above (O(1)), not a live count(*) (O(n)), for the filtered
-- case, which is the one that matters most for "fast at large page
-- numbers" since it's the common case in a real catalog UI.
-- ---------------------------------------------------------------------

create or replace function get_products_page(
    p_category   text     default null,   -- null = no category filter
    p_cursor_id  bigint   default null,   -- null = first page
    p_limit      int      default 20
)
returns table (
    id          bigint,
    name        text,
    category    text,
    price       numeric,
    created_at  timestamptz,
    updated_at  timestamptz,
    total_count bigint
)
language plpgsql
stable
as $$
declare
    v_total bigint;
begin
    if p_category is null then
        -- Unfiltered "browse everything" total. This is the one
        -- remaining O(n)-ish path in this design: swap for a cached/
        -- materialized sum if unfiltered traffic at scale matters for
        -- your use case. Left as count(*) here for simplicity at this
        -- assignment's ~200k-row scope.
        select count(*) into v_total from products;
    else
        select coalesce(cc.product_count, 0) into v_total
        from category_counts cc
        where cc.category = p_category;
    end if;

    return query
    select
        p.id, p.name, p.category, p.price, p.created_at, p.updated_at,
        v_total
    from products p
    where (p_category is null or p.category = p_category)
      and (p_cursor_id is null or p.id < p_cursor_id)
    order by p.id desc
    limit p_limit;
end;
$$;

comment on function get_products_page is
    'Keyset-paginated product listing. Sort key is id DESC (monotonic,
     immutable) so pages stay correct under concurrent inserts/updates.
     total_count is O(1) via category_counts when a category filter is
     given; falls back to count(*) for the unfiltered case (see inline
     comment).';
