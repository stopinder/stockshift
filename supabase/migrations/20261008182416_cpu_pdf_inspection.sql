-- CPU inspection is independent of extraction, correction and comparison.
-- Hosted uploads remain disabled; API/UI integration is a later increment.
create table public.pdf_inspections (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id), source_file_id uuid not null,
 created_by uuid not null default auth.uid() references auth.users(id),
 inspector_version text not null default 'cpu-inspection-v1' check(inspector_version='cpu-inspection-v1'),
 status text not null default 'queued' check(status in ('queued','running','inspected','ocr_required','failed')),
 page_count integer check(page_count between 1 and 50), diagnostics jsonb,
 result_digest text, failure_reason jsonb check(failure_reason is null or jsonb_typeof(failure_reason)='object'),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(tenant_id,id), unique(tenant_id,source_file_id,inspector_version),
 foreign key(tenant_id,source_file_id) references public.source_files(tenant_id,id),
 check((status in ('inspected','ocr_required')) =
   (page_count is not null and diagnostics is not null and result_digest is not null)),
 check(diagnostics is null or (jsonb_typeof(diagnostics)='array' and octet_length(diagnostics::text)<=32768))
);
alter table public.pdf_inspections enable row level security;
revoke all on public.pdf_inspections from public,anon,authenticated,service_role;
grant select on public.pdf_inspections to authenticated,service_role;
create policy tenant_read on public.pdf_inspections for select to authenticated
 using(private.has_role(tenant_id,array['owner','editor','viewer']));
create function private.guard_pdf_inspection() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or old.result_digest is not null then
  raise exception 'Inspection evidence is immutable' using errcode='23514'; end if;
 if (new.id,new.tenant_id,new.source_file_id,new.created_by,new.inspector_version) is distinct from
    (old.id,old.tenant_id,old.source_file_id,old.created_by,old.inspector_version) then
  raise exception 'Inspection identity is immutable' using errcode='23514'; end if;
 new.updated_at=clock_timestamp(); return new;
end $$;
create trigger immutable_inspection before update or delete on public.pdf_inspections
 for each row execute function private.guard_pdf_inspection();
revoke all on function private.guard_pdf_inspection() from public,anon,authenticated,service_role;

alter table public.jobs add column inspection_run_id uuid unique;
alter table public.jobs add foreign key(tenant_id,inspection_run_id) references public.pdf_inspections(tenant_id,id);
alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check(
 (kind='reconcile_csv' and comparison_run_id is not null and extraction_run_id is null and inspection_run_id is null)
 or (kind='extract_pdf' and comparison_run_id is null and extraction_run_id is not null and inspection_run_id is null)
 or (kind='inspect_pdf' and comparison_run_id is null and extraction_run_id is null and inspection_run_id is not null));

create or replace function private.claim_csv_job(p_worker uuid,p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; token uuid; expired jsonb='{"code":"lease_expired","stage":"lease","message":"Worker lease expired","retryable":true}'::jsonb;
begin
  if p_worker is null or p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'Invalid worker lease' using errcode='23514';
  end if;
  loop
    select * into j from public.jobs where
      (status in ('queued','retry_wait') and available_at<=clock_timestamp())
      or (status='running' and lease_expires_at<=clock_timestamp())
      order by available_at,created_at,id for update skip locked limit 1;
    if not found then return null; end if;
    if j.status='running' then
      update public.job_attempts set status='expired',failure_reason=expired,finished_at=clock_timestamp()
        where tenant_id=j.tenant_id and job_id=j.id and lease_token=j.lease_token;
    end if;
    if j.attempt_count>=j.max_attempts then
      update public.jobs set status='dead_letter',lease_owner=null,lease_token=null,
        lease_expires_at=null,failure_reason=expired where id=j.id;
      update public.comparison_runs set status='failed'
        where tenant_id=j.tenant_id and id=j.comparison_run_id;
      update public.extraction_runs set status='failed',failure_reason=expired where tenant_id=j.tenant_id and id=j.extraction_run_id;
      update public.pdf_inspections set status='failed',failure_reason=expired where tenant_id=j.tenant_id and id=j.inspection_run_id;
      continue;
    end if;
    token=gen_random_uuid();
    update public.jobs set status='running',attempt_count=attempt_count+1,lease_owner=p_worker,
      lease_token=token,lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
      where id=j.id returning * into j;
    insert into public.job_attempts(tenant_id,job_id,attempt_number,lease_owner,lease_token,status)
      values(j.tenant_id,j.id,j.attempt_count,p_worker,token,'running');
    update public.comparison_runs set status='running'
      where tenant_id=j.tenant_id and id=j.comparison_run_id;
    update public.extraction_runs set status='running' where tenant_id=j.tenant_id and id=j.extraction_run_id;
    update public.pdf_inspections set status='running',failure_reason=null where tenant_id=j.tenant_id and id=j.inspection_run_id;
    return to_jsonb(j);
  end loop;
end $$;

create or replace function private.fail_csv_job(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,
  p_failure jsonb,p_retryable boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs; state text;
begin
  j=private.leased_job(p_tenant,p_job,p_worker,p_token);
  if jsonb_typeof(p_failure) is distinct from 'object'
    or not (p_failure ?& array['code','stage','message']) or length(p_failure::text)>2000
    or p_retryable is null then raise exception 'Structured failure required' using errcode='23514'; end if;
  state=case when not p_retryable then 'failed' when j.attempt_count>=j.max_attempts
    then 'dead_letter' else 'retry_wait' end;
  update public.job_attempts set status='failed',failure_reason=p_failure,
    finished_at=clock_timestamp() where tenant_id=p_tenant and job_id=j.id and lease_token=p_token;
  update public.jobs set status=state,lease_owner=null,lease_token=null,lease_expires_at=null,
    failure_reason=p_failure,available_at=clock_timestamp()+make_interval(secs=>
      least(300,5*power(2,j.attempt_count-1)::integer)) where id=j.id returning * into j;
  update public.comparison_runs set status=case when state='retry_wait' then 'queued' else 'failed' end
    where tenant_id=p_tenant and id=j.comparison_run_id;
  update public.extraction_runs set status=case when state='retry_wait' then 'queued' else 'failed' end,failure_reason=p_failure where tenant_id=p_tenant and id=j.extraction_run_id;
  update public.pdf_inspections set status=case when state='retry_wait' then 'queued' else 'failed' end,failure_reason=p_failure where tenant_id=p_tenant and id=j.inspection_run_id;
  return to_jsonb(j);
end $$;

create function private.enqueue_pdf_inspection(p_tenant uuid,p_file uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.pdf_inspections; j public.jobs;
begin
 if not private.has_role(p_tenant,array['owner','editor']) then
  raise exception 'Editor required' using errcode='42501'; end if;
 perform 1 from public.source_files where tenant_id=p_tenant and id=p_file
  and status='ready' and verified_mime='application/pdf' and byte_count between 1 and 10485760;
 if not found then raise exception 'Ready PDF outside tenant' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||p_file::text||'cpu-inspection-v1',0));
 select * into i from public.pdf_inspections where tenant_id=p_tenant and source_file_id=p_file
  and inspector_version='cpu-inspection-v1';
 if not found then
  insert into public.pdf_inspections(tenant_id,source_file_id) values(p_tenant,p_file) returning * into i;
  insert into public.jobs(tenant_id,kind,inspection_run_id,idempotency_key)
   values(p_tenant,'inspect_pdf',i.id,'inspect:'||i.id) returning * into j;
 else
  select * into strict j from public.jobs where tenant_id=p_tenant and inspection_run_id=i.id;
 end if;
 return jsonb_build_object('inspection',to_jsonb(i),'job',to_jsonb(j));
end $$;

create function private.load_pdf_inspection(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; i public.pdf_inspections; f public.source_files;
begin
 j=private.leased_job(p_tenant,p_job,p_worker,p_token);
 if j.kind<>'inspect_pdf' then raise exception 'Inspection job required' using errcode='23514'; end if;
 select * into strict i from public.pdf_inspections where tenant_id=p_tenant and id=j.inspection_run_id;
 select * into strict f from public.source_files where tenant_id=p_tenant and id=i.source_file_id
  and status='ready' and verified_mime='application/pdf';
 return jsonb_build_object('inspection',to_jsonb(i),'file',to_jsonb(f));
end $$;

create function private.complete_pdf_inspection(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; i public.pdf_inspections; digest text; item jsonb; n integer=0; needs_ocr boolean=false;
begin
 select * into j from public.jobs where tenant_id=p_tenant and id=p_job for update;
 if not found or j.kind<>'inspect_pdf' then raise exception 'Inspection job outside tenant' using errcode='42501'; end if;
 select * into strict i from public.pdf_inspections where tenant_id=p_tenant and id=j.inspection_run_id;
 if jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>32768
  or not (p_result ?& array['version','page_count','state','diagnostics'])
  or (p_result-array['version','page_count','state','diagnostics'])<>'{}'::jsonb
  or p_result->>'version' is distinct from i.inspector_version
  or jsonb_typeof(p_result->'page_count') is distinct from 'number'
  or coalesce(p_result->>'page_count','') !~ '^[1-9][0-9]?$'
  or (p_result->>'page_count')::integer>50
  or coalesce(p_result->>'state','') not in ('inspected','ocr_required')
  or jsonb_typeof(p_result->'diagnostics') is distinct from 'array' then
  raise exception 'Invalid bounded inspection result' using errcode='23514'; end if;
 if jsonb_array_length(p_result->'diagnostics')<>(p_result->>'page_count')::integer then
  raise exception 'Incomplete inspection diagnostics' using errcode='23514'; end if;
 for item in select value from jsonb_array_elements(p_result->'diagnostics') loop
  n=n+1;
  if jsonb_typeof(item) is distinct from 'object'
   or not (item ?& array['page','state','code','table_count'])
   or (item-array['page','state','code','table_count'])<>'{}'::jsonb
   or jsonb_typeof(item->'page') is distinct from 'number' or item->>'page' is distinct from n::text
   or jsonb_typeof(item->'table_count') is distinct from 'number'
   or coalesce(item->>'table_count','') !~ '^(0|[1-9][0-9]?)$'
   or (item->>'table_count')::integer>32
   or coalesce(item->>'state','') not in ('digital_candidate','ocr_required')
   or coalesce(item->>'code','') not in ('ruled_table_candidate','unsupported_table_structure','no_usable_embedded_table')
   or ((item->>'state'='digital_candidate') is distinct from (item->>'code'='ruled_table_candidate'))
   or (item->>'state'='digital_candidate' and (item->>'table_count')::integer=0) then
   raise exception 'Invalid page diagnostics' using errcode='23514'; end if;
  needs_ocr=needs_ocr or item->>'state'='ocr_required';
 end loop;
 if (p_result->>'state'='ocr_required') is distinct from needs_ocr then
  raise exception 'Inspection summary differs from pages' using errcode='23514'; end if;
 digest=encode(sha256(convert_to(p_result::text,'UTF8')),'hex');
 if j.status='succeeded' and j.completed_lease_token=p_token and exists(
  select 1 from public.job_attempts where tenant_id=p_tenant and job_id=p_job and lease_token=p_token and lease_owner=p_worker) then
  if i.result_digest is distinct from digest then raise exception 'Conflicting inspection completion' using errcode='23514'; end if;
  return to_jsonb(i);
 end if;
 j=private.leased_job(p_tenant,p_job,p_worker,p_token);
 update public.pdf_inspections set status=p_result->>'state',page_count=(p_result->>'page_count')::integer,
  diagnostics=p_result->'diagnostics',result_digest=digest,failure_reason=null
  where tenant_id=p_tenant and id=i.id returning * into i;
 update public.job_attempts set status='succeeded',finished_at=clock_timestamp()
  where tenant_id=p_tenant and job_id=p_job and lease_token=p_token;
 update public.jobs set status='succeeded',completed_lease_token=p_token,lease_owner=null,lease_token=null,
  lease_expires_at=null,failure_reason=null where tenant_id=p_tenant and id=p_job;
 return to_jsonb(i);
end $$;

create function public.enqueue_pdf_inspection(p_tenant uuid,p_file uuid) returns jsonb
 language sql security invoker set search_path='' as $$ select private.enqueue_pdf_inspection(p_tenant,p_file); $$;
revoke all on function private.enqueue_pdf_inspection(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.enqueue_pdf_inspection(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.enqueue_pdf_inspection(uuid,uuid) to authenticated;
grant execute on function public.enqueue_pdf_inspection(uuid,uuid) to authenticated;

create function public.load_pdf_inspection(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid) returns jsonb
 language sql security invoker set search_path='' as $$ select private.load_pdf_inspection(p_tenant,p_job,p_worker,p_token); $$;
create function public.complete_pdf_inspection(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,p_result jsonb) returns jsonb
 language sql security invoker set search_path='' as $$ select private.complete_pdf_inspection(p_tenant,p_job,p_worker,p_token,p_result); $$;
revoke all on function private.load_pdf_inspection(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.load_pdf_inspection(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function private.complete_pdf_inspection(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.complete_pdf_inspection(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.load_pdf_inspection(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.load_pdf_inspection(uuid,uuid,uuid,uuid) to service_role;
grant execute on function private.complete_pdf_inspection(uuid,uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.complete_pdf_inspection(uuid,uuid,uuid,uuid,jsonb) to service_role;
