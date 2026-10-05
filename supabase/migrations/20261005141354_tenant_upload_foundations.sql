begin;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default now()
);
create table public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index memberships_user_tenant on public.tenant_memberships(user_id, tenant_id);
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create table public.import_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create table public.source_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  created_by uuid not null references auth.users(id),
  supplier_id uuid,
  import_profile_id uuid,
  original_filename text not null check (
    length(original_filename) between 1 and 255 and original_filename !~ '[/\\]'
    and original_filename !~ '[[:cntrl:]]' and lower(original_filename) ~ '\.csv$'
  ),
  bucket_id text not null default 'catalogue-uploads' check (bucket_id = 'catalogue-uploads'),
  object_name text generated always as (tenant_id::text || '/' || id::text || '/original') stored,
  expected_byte_count bigint not null check (expected_byte_count between 1 and 10485760),
  status text not null default 'pending' check (status in ('pending', 'verifying', 'ready', 'failed')),
  byte_count bigint,
  verified_mime text,
  sha256 text,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  unique (tenant_id, id), unique (bucket_id, object_name),
  foreign key (tenant_id, supplier_id) references public.suppliers(tenant_id, id),
  foreign key (tenant_id, import_profile_id) references public.import_profiles(tenant_id, id),
  check (
    (status = 'ready' and byte_count = expected_byte_count and byte_count is not null
      and verified_mime = 'text/csv' and verified_mime is not null
      and sha256 ~ '^[0-9a-f]{64}$' and length(sha256) = 64
      and sha256 is not null and finalized_at is not null)
    or (status <> 'ready' and byte_count is null and verified_mime is null
      and sha256 is null and finalized_at is null)
  )
);
create table public.comparisons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  supplier_id uuid,
  title text not null check (length(btrim(title)) between 1 and 200),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, supplier_id) references public.suppliers(tenant_id, id)
);
create table public.comparison_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  comparison_id uuid not null,
  source_file_id uuid not null,
  side text not null check (side in ('current', 'incoming')),
  created_at timestamptz not null default now(),
  unique (comparison_id, side), unique (comparison_id, source_file_id),
  foreign key (tenant_id, comparison_id) references public.comparisons(tenant_id, id),
  foreign key (tenant_id, source_file_id) references public.source_files(tenant_id, id)
);
create index source_files_tenant_created on public.source_files(tenant_id, created_at, id);
create index comparisons_tenant_created on public.comparisons(tenant_id, created_at, id);
create index comparison_files_tenant_comparison on public.comparison_files(tenant_id, comparison_id);

-- Only answers questions about the current authenticated user's live membership.
-- Definer avoids policy recursion; never authorizes from JWT metadata.
create function private.has_role(p_tenant uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.tenant_memberships
    where tenant_id = p_tenant and user_id = auth.uid() and role = any(p_roles)
  );
$$;
do $$
declare t text;
begin
  foreach t in array array['tenants','tenant_memberships','suppliers','source_files',
                           'import_profiles','comparisons','comparison_files'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated, service_role', t);
    execute format('create policy tenant_read on public.%I for select to authenticated
      using (private.has_role(%s, array[''owner'',''editor'',''viewer'']))',
      t, case when t = 'tenants' then 'id' else 'tenant_id' end);
  end loop;
  foreach t in array array['suppliers','import_profiles','comparisons','comparison_files'] loop
    execute format('grant insert on public.%I to authenticated', t);
    execute format('create policy editor_insert on public.%I for insert to authenticated
      with check (private.has_role(tenant_id, array[''owner'',''editor'']) %s)', t,
      case when t = 'comparisons' then 'and created_by = auth.uid()' else '' end);
    execute format('create policy editor_update on public.%I for update to authenticated
      using (private.has_role(tenant_id, array[''owner'',''editor'']))
      with check (private.has_role(tenant_id, array[''owner'',''editor'']))', t);
  end loop;
end $$;
grant update (name) on public.tenants to authenticated;
create policy owner_settings on public.tenants for update to authenticated
  using (private.has_role(id, array['owner'])) with check (private.has_role(id, array['owner']));
grant update (name) on public.suppliers to authenticated;
grant update (name, configuration) on public.import_profiles to authenticated;
grant update (title, supplier_id) on public.comparisons to authenticated;
grant update (side) on public.comparison_files to authenticated;

create function private.immutable_tenant() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tenant_id <> old.tenant_id or new.id <> old.id then
    raise exception 'Tenant and resource identity are immutable' using errcode = '23514';
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['tenant_memberships','suppliers','import_profiles','comparisons','comparison_files'] loop
    execute format('create trigger immutable_tenant before update on public.%I
      for each row execute function private.immutable_tenant()', t);
  end loop;
end $$;
create function private.guard_source_file() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'ready' then
    raise exception 'Finalized source files are immutable' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if (new.id, new.tenant_id, new.created_by, new.original_filename, new.bucket_id,
      new.expected_byte_count, new.supplier_id, new.import_profile_id, new.created_at)
     is distinct from
     (old.id, old.tenant_id, old.created_by, old.original_filename, old.bucket_id,
      old.expected_byte_count, old.supplier_id, old.import_profile_id, old.created_at) then
    raise exception 'Registered upload identity is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger guard_source_file before update or delete on public.source_files
  for each row execute function private.guard_source_file();
create function private.require_ready_file() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.source_files
    where id = new.source_file_id and tenant_id = new.tenant_id and status = 'ready') then
    raise exception 'Only a ready same-tenant source file can be attached' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger ready_comparison_file before insert or update on public.comparison_files
  for each row execute function private.require_ready_file();

create function private.manage_member(p_tenant uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.tenants where id = p_tenant for update;
  if not private.has_role(p_tenant, array['owner']) or p_user = auth.uid() then
    raise exception 'Only an owner may manage other members' using errcode = '42501';
  end if;
  if p_role is not null and p_role not in ('owner','editor','viewer') then
    raise exception 'Invalid membership role' using errcode = '23514';
  end if;
  if p_role is null then
    delete from public.tenant_memberships where tenant_id = p_tenant and user_id = p_user;
  else
    insert into public.tenant_memberships (tenant_id, user_id, role) values (p_tenant, p_user, p_role)
    on conflict (tenant_id, user_id) do update set role = excluded.role;
  end if;
end $$;
create function public.manage_tenant_member(p_tenant uuid, p_user uuid, p_role text) returns void
language sql security invoker set search_path = '' as $$
  select private.manage_member(p_tenant, p_user, p_role);
$$;
create function private.create_intent(p_tenant uuid, p_filename text, p_bytes bigint,
  p_supplier uuid, p_profile uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.source_files;
begin
  if not private.has_role(p_tenant, array['owner','editor']) then
    raise exception 'Upload requires editor membership' using errcode = '42501';
  end if;
  insert into public.source_files (tenant_id, created_by, original_filename, expected_byte_count,
                                 supplier_id, import_profile_id)
    values (p_tenant, auth.uid(), p_filename, p_bytes, p_supplier, p_profile) returning * into f;
  return to_jsonb(f);
end $$;
create function public.create_upload_intent(p_tenant uuid, p_filename text, p_bytes bigint,
  p_supplier uuid default null, p_profile uuid default null) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.create_intent(p_tenant, p_filename, p_bytes, p_supplier, p_profile);
$$;

-- Actor must be freshly authenticated by server. Checks also apply to service_role.
create function private.transition_upload(p_tenant uuid, p_file uuid, p_actor uuid,
  p_action text, p_bytes bigint, p_mime text, p_sha text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.source_files; obj storage.objects;
begin
  select * into f from public.source_files where tenant_id = p_tenant and id = p_file for update;
  if not found or f.created_by <> p_actor or not exists (
    select 1 from public.tenant_memberships where tenant_id = p_tenant
      and user_id = p_actor and role in ('owner','editor')) then
    raise exception 'Upload does not belong to authorized actor' using errcode = '42501';
  end if;
  if f.status = 'ready' and p_action = 'begin' then return to_jsonb(f); end if;
  if p_action = 'fail' and f.status = 'verifying' then
    update public.source_files set status = 'failed' where id = p_file returning * into f;
    return to_jsonb(f);
  end if;
  select * into obj from storage.objects where bucket_id = f.bucket_id and name = f.object_name;
  if not found or obj.owner_id is distinct from p_actor::text
    or (obj.metadata->>'size')::bigint is distinct from f.expected_byte_count then
    raise exception 'Registered object ownership or size is invalid' using errcode = '23514';
  end if;
  if p_action = 'begin' and f.status = 'pending' then
    update public.source_files set status = 'verifying' where id = p_file returning * into f;
  elsif p_action = 'finish' and f.status = 'verifying' then
    update public.source_files set status = 'ready', byte_count = p_bytes, verified_mime = p_mime,
      sha256 = p_sha, finalized_at = now() where id = p_file returning * into f;
  else
    raise exception 'Invalid upload transition' using errcode = '23514';
  end if;
  return to_jsonb(f);
end $$;
create function public.transition_catalogue_upload(p_tenant uuid, p_file uuid, p_actor uuid,
  p_action text, p_bytes bigint default null, p_mime text default null, p_sha text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.transition_upload(p_tenant, p_file, p_actor, p_action, p_bytes, p_mime, p_sha);
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalogue-uploads', 'catalogue-uploads', false, 10485760,
        array['text/csv','application/octet-stream','application/vnd.ms-excel']);
create policy catalogue_object_read on storage.objects for select to authenticated using (
  bucket_id = 'catalogue-uploads' and exists (
    select 1 from public.source_files f where f.bucket_id = storage.objects.bucket_id
      and f.object_name = storage.objects.name
      and private.has_role(f.tenant_id, array['owner','editor','viewer'])
  )
);
create policy catalogue_object_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'catalogue-uploads' and owner_id = auth.uid()::text and exists (
    select 1 from public.source_files f where f.bucket_id = storage.objects.bucket_id
      and f.object_name = storage.objects.name and f.status = 'pending' and f.created_by = auth.uid()
      and private.has_role(f.tenant_id, array['owner','editor'])
  )
);
-- No object UPDATE/DELETE policies. No application path can overwrite/move/remove uploads.
create function private.guard_storage_object() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.bucket_id = 'catalogue-uploads' and exists (
    select 1 from public.source_files where bucket_id = old.bucket_id and object_name = old.name
  ) then
    raise exception 'Registered upload objects cannot be changed or deleted' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger immutable_catalogue_object before update or delete on storage.objects
  for each row execute function private.guard_storage_object();

revoke all on all functions in schema private from public, anon, authenticated, service_role;
grant execute on function private.has_role(uuid, text[]) to authenticated;
grant execute on function private.manage_member(uuid, uuid, text) to authenticated;
grant execute on function private.create_intent(uuid, text, bigint, uuid, uuid) to authenticated;
grant execute on function private.transition_upload(uuid, uuid, uuid, text, bigint, text, text) to service_role;
revoke all on function public.manage_tenant_member(uuid, uuid, text) from public, anon, service_role;
revoke all on function public.create_upload_intent(uuid, text, bigint, uuid, uuid) from public, anon, service_role;
revoke all on function public.transition_catalogue_upload(uuid, uuid, uuid, text, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.manage_tenant_member(uuid, uuid, text) to authenticated;
grant execute on function public.create_upload_intent(uuid, text, bigint, uuid, uuid) to authenticated;
grant execute on function public.transition_catalogue_upload(uuid, uuid, uuid, text, bigint, text, text)
  to service_role;
commit;
