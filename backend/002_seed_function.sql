
create or replace function seed_products_batch(
    p_count       int,
    p_start_offset bigint    
)
returns void
language sql
as $$
    insert into products (name, category, price, created_at, updated_at)
    select
      
        initcap(adjectives.word) || ' ' || initcap(nouns.word) || ' ' ||
            (1000 + (random() * 8999)::int)::text,
        categories.word,
       
        round((4.99 + power(random(), 2) * 995)::numeric, 2),
       
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
