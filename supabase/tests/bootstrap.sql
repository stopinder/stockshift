-- Minimal local Auth/Storage contracts for embedded PostgreSQL tests only.
-- Never install these fixtures into a real Supabase database.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create schema storage;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub','')::uuid;
$$;
create table storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text not null, owner_id text, metadata jsonb, unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
