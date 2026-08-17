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
