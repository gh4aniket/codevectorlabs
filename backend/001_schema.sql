

create table if not exists products (
    id          bigserial primary key,
    name        text           not null,
    category    text           not null,
    price       numeric(10,2)  not null,
    created_at  timestamptz    not null default now(),
    updated_at  timestamptz    not null default now()
);

-- Indexes

create index if not exists idx_products_category_id
    on products (category, id desc);

create index if not exists idx_products_updated_at
    on products (updated_at desc);



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


create or replace function rebuild_category_counts() returns void
language sql as $$
    truncate category_counts;
    insert into category_counts (category, product_count)
    select category, count(*) from products group by category;
$$;



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
