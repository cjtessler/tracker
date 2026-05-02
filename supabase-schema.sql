-- Pedal Tracker Supabase schema
-- Paste this into the Supabase SQL editor and run once per project.

create table if not exists public.sessions (
  id             bigint primary key,           -- client Date.now() session id
  start_time     timestamptz not null,
  end_time       timestamptz,
  active_section text not null,
  sections       jsonb not null,               -- {section: {count, timestamps[]}}
  device_id      text,                         -- diagnostic only
  synced_at      timestamptz not null default now()
);

create index if not exists sessions_start_time_idx
  on public.sessions (start_time desc);

alter table public.sessions enable row level security;

drop policy if exists "anon read"   on public.sessions;
drop policy if exists "anon insert" on public.sessions;
drop policy if exists "anon delete" on public.sessions;

create policy "anon read"
  on public.sessions for select
  to anon
  using (true);

create policy "anon insert"
  on public.sessions for insert
  to anon
  with check (true);

create policy "anon delete"
  on public.sessions for delete
  to anon
  using (true);
-- No update policy: completed sessions are immutable.
