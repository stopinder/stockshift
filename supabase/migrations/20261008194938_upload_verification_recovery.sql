-- Verification fencing follows the durable job lease pattern without rewriting sources.
create table private.upload_verification_leases (
  source_file_id uuid primary key references public.source_files(id),
  lease_token uuid not null,
  expires_at timestamptz not null,
  attempt_count integer not null check (attempt_count between 1 and 5)
);
alter table private.upload_verification_leases enable row level security;
revoke all on private.upload_verification_leases from public, anon, authenticated, service_role;

create function private.transition_upload_leased(p_tenant uuid, p_file uuid, p_actor uuid,
  p_action text, p_bytes bigint, p_mime text, p_sha text, p_lease uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.source_files; obj storage.objects; v private.upload_verification_leases;
begin
  select * into f from public.source_files where tenant_id=p_tenant and id=p_file for update;
  if not found or f.created_by is distinct from p_actor or not exists (
    select 1 from public.tenant_memberships where tenant_id=p_tenant and user_id=p_actor and role in ('owner','editor')) then
    raise exception 'Upload does not belong to authorized actor' using errcode='42501';
  end if;
  if f.status='ready' and p_action='begin' then return to_jsonb(f); end if;
  select * into v from private.upload_verification_leases where source_file_id=p_file;
  if p_action='begin' then
    if f.status not in ('pending','verifying') then
      raise exception 'Upload cannot be finalized' using errcode='23514';
    end if;
    if v.source_file_id is not null and v.expires_at>clock_timestamp() then
      raise exception 'Upload verification in progress. Retry after lease expiry.' using errcode='55P03';
    end if;
    if v.attempt_count>=5 then
      update public.source_files set status='failed' where id=p_file returning * into f;
      return to_jsonb(f)||jsonb_build_object('verification_exhausted',true);
    end if;
  else
    if p_lease is null or p_lease is distinct from v.lease_token then
      raise exception 'Upload verification lease is stale or missing' using errcode='42501';
    end if;
    -- A lost finish response may be retried, but only the committing attempt can replay it.
    if f.status='ready' and p_action='finish' and f.byte_count is not distinct from p_bytes
      and f.verified_mime is not distinct from p_mime and f.sha256 is not distinct from p_sha then
      return to_jsonb(f);
    end if;
    if f.status<>'verifying' or v.expires_at<=clock_timestamp() then
      raise exception 'Upload verification lease is no longer live' using errcode='55P03';
    end if;
    if p_action='retry' then
      update private.upload_verification_leases set expires_at=least(expires_at,clock_timestamp()) where source_file_id=p_file;
      return to_jsonb(f);
    elsif p_action='fail' then
      update public.source_files set status='failed' where id=p_file returning * into f;
      return to_jsonb(f);
    elsif p_action<>'finish' then
      raise exception 'Invalid upload transition' using errcode='23514';
    end if;
  end if;
  -- Both initial/recovered claims and completion recheck immutable registered Storage metadata.
  select * into obj from storage.objects where bucket_id=f.bucket_id and name=f.object_name;
  if not found or obj.owner_id is distinct from p_actor::text
    or (obj.metadata->>'size')::bigint is distinct from f.expected_byte_count then
    raise exception 'Registered object ownership or size is invalid' using errcode='23514';
  end if;
  if p_action='begin' then
    insert into private.upload_verification_leases values(p_file,gen_random_uuid(),clock_timestamp()+interval '120 seconds',coalesce(v.attempt_count,0)+1)
      on conflict(source_file_id) do update set lease_token=excluded.lease_token,expires_at=excluded.expires_at,attempt_count=excluded.attempt_count
      returning * into v;
    update public.source_files set status='verifying' where id=p_file returning * into f;
    return to_jsonb(f)||jsonb_build_object('verification_lease',v.lease_token,'verification_expires_at',v.expires_at,'verification_attempt',v.attempt_count);
  end if;
  if p_bytes is distinct from f.expected_byte_count or p_sha is null
    or length(p_sha)<>64 or p_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'Verified size or SHA-256 is invalid' using errcode='23514';
  end if;
  if v.expires_at<=clock_timestamp() then
    raise exception 'Upload verification lease expired before completion' using errcode='55P03';
  end if;
  update public.source_files set status='ready',byte_count=p_bytes,verified_mime=p_mime,sha256=p_sha,finalized_at=clock_timestamp()
    where id=p_file returning * into f;
  return to_jsonb(f);
end $$;

-- Keep the old signature for begin/ready compatibility; unfenced finish/fail is rejected.
create or replace function private.transition_upload(p_tenant uuid,p_file uuid,p_actor uuid,
  p_action text,p_bytes bigint,p_mime text,p_sha text) returns jsonb
language sql security definer set search_path='' as $$
  select private.transition_upload_leased(p_tenant,p_file,p_actor,p_action,p_bytes,p_mime,p_sha,null);
$$;
create function public.transition_catalogue_upload(p_tenant uuid,p_file uuid,p_actor uuid,
  p_action text,p_bytes bigint,p_mime text,p_sha text,p_lease uuid) returns jsonb
language sql security invoker set search_path='' as $$
  select private.transition_upload_leased(p_tenant,p_file,p_actor,p_action,p_bytes,p_mime,p_sha,p_lease);
$$;
revoke all on function private.transition_upload_leased(uuid,uuid,uuid,text,bigint,text,text,uuid) from public,anon,authenticated;
revoke all on function public.transition_catalogue_upload(uuid,uuid,uuid,text,bigint,text,text,uuid) from public,anon,authenticated;
grant execute on function private.transition_upload_leased(uuid,uuid,uuid,text,bigint,text,text,uuid) to service_role;
grant execute on function public.transition_catalogue_upload(uuid,uuid,uuid,text,bigint,text,text,uuid) to service_role;
