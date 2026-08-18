-- V2 artist quarter bank — run once in Supabase SQL Editor
-- https://supabase.com/dashboard/project/obrjpgucgcrclukkvook/sql

create table if not exists artists (
  id uuid primary key default gen_random_uuid(),
  artist_key text unique not null,
  artist_name text not null,
  record_label text,
  active_quarter text,
  updated_at timestamptz not null default now()
);

create table if not exists artist_quarters (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists(id) on delete cascade,
  quarter_key text not null,
  status text not null default 'active' check (status in ('active', 'banked')),
  row_count int not null default 0,
  file_name text,
  uploaded_at timestamptz,
  banked_at timestamptz,
  unique (artist_id, quarter_key)
);

create index if not exists artist_quarters_artist_idx on artist_quarters (artist_id);

create table if not exists artist_quarter_chunks (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists(id) on delete cascade,
  quarter_key text not null,
  chunk_index int not null,
  rows jsonb not null,
  unique (artist_id, quarter_key, chunk_index)
);

create index if not exists artist_quarter_chunks_lookup_idx
  on artist_quarter_chunks (artist_id, quarter_key, chunk_index);

create table if not exists artist_rollups (
  artist_id uuid primary key references artists(id) on delete cascade,
  rollup jsonb not null default '{}'::jsonb,
  banked_quarters text[] not null default '{}',
  active_quarter text,
  updated_at timestamptz not null default now()
);

alter table artists enable row level security;
alter table artist_quarters enable row level security;
alter table artist_quarter_chunks enable row level security;
alter table artist_rollups enable row level security;

-- Match current reports pattern: open access via anon key (tighten before public launch)
drop policy if exists "v2 artists anon all" on artists;
create policy "v2 artists anon all" on artists for all using (true) with check (true);

drop policy if exists "v2 artist_quarters anon all" on artist_quarters;
create policy "v2 artist_quarters anon all" on artist_quarters for all using (true) with check (true);

drop policy if exists "v2 artist_quarter_chunks anon all" on artist_quarter_chunks;
create policy "v2 artist_quarter_chunks anon all" on artist_quarter_chunks for all using (true) with check (true);

drop policy if exists "v2 artist_rollups anon all" on artist_rollups;
create policy "v2 artist_rollups anon all" on artist_rollups for all using (true) with check (true);

-- Hide a published report from label indexes without deleting the row.
create or replace function hide_report_from_label_index(report_id uuid, hidden boolean default true)
returns void
language sql
security definer
as $$
  update reports
  set campaign_data = jsonb_set(coalesce(campaign_data, '{}'::jsonb), '{hiddenFromLabelIndex}', to_jsonb(hidden), true)
  where id = report_id;
$$;

grant execute on function hide_report_from_label_index(uuid, boolean) to anon, authenticated;

-- Shared UPC / variant SKU catalogue. Grows from sales uploads; not stored in each report payload.
create table if not exists product_skus (
  sku text primary key,
  product_title text not null default '',
  variant_title text not null default '',
  product_type text,
  artist_name text,
  record_label text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists product_skus_artist_idx on product_skus (artist_name);
create index if not exists product_skus_title_idx on product_skus (product_title);

alter table product_skus enable row level security;
drop policy if exists "v2 product_skus anon all" on product_skus;
create policy "v2 product_skus anon all" on product_skus for all using (true) with check (true);

create or replace function upsert_product_skus(entries jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  rec jsonb;
  n_added int := 0;
  n_seen int := 0;
  existed boolean;
  sku_val text;
begin
  if entries is null or jsonb_typeof(entries) <> 'array' then
    return jsonb_build_object('added', 0, 'seen', 0, 'total', (select count(*)::int from product_skus));
  end if;

  for rec in select * from jsonb_array_elements(entries)
  loop
    sku_val := trim(coalesce(rec->>'sku', ''));
    if sku_val = '' then continue; end if;
    n_seen := n_seen + 1;
    select exists(select 1 from product_skus where sku = sku_val) into existed;

    insert into product_skus as ps (
      sku, product_title, variant_title, product_type, artist_name, record_label
    ) values (
      sku_val,
      coalesce(trim(rec->>'product_title'), ''),
      coalesce(trim(rec->>'variant_title'), ''),
      nullif(trim(coalesce(rec->>'product_type', '')), ''),
      nullif(trim(coalesce(rec->>'artist_name', '')), ''),
      nullif(trim(coalesce(rec->>'record_label', '')), '')
    )
    on conflict (sku) do update set
      product_title = case when excluded.product_title <> '' then excluded.product_title else ps.product_title end,
      variant_title = case when excluded.variant_title <> '' then excluded.variant_title else ps.variant_title end,
      product_type = coalesce(excluded.product_type, ps.product_type),
      artist_name = coalesce(excluded.artist_name, ps.artist_name),
      record_label = coalesce(excluded.record_label, ps.record_label),
      last_seen_at = now();

    if not existed then n_added := n_added + 1; end if;
  end loop;

  return jsonb_build_object(
    'added', n_added,
    'seen', n_seen,
    'total', (select count(*)::int from product_skus)
  );
end;
$$;

grant execute on function upsert_product_skus(jsonb) to anon, authenticated;
