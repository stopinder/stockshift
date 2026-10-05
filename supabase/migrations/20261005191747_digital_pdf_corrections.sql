-- Digital PDFs use the same fenced queue; extracted evidence and revisions are immutable.
alter table public.source_files drop constraint source_files_original_filename_check;
alter table public.source_files add constraint source_files_original_filename_check check (
 length(original_filename) between 1 and 255 and original_filename !~ '[/\\]'
 and original_filename !~ '[[:cntrl:]]' and lower(original_filename) ~ '\.(csv|xlsx|pdf)$');
alter table public.source_files drop constraint source_files_check;
alter table public.source_files add constraint source_files_check check (
 (status='ready' and byte_count=expected_byte_count and byte_count is not null and verified_mime is not null
 and ((lower(original_filename) ~ '\.csv$' and verified_mime='text/csv')
 or (lower(original_filename) ~ '\.xlsx$' and verified_mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
 or (lower(original_filename) ~ '\.pdf$' and verified_mime='application/pdf'))
 and sha256 ~ '^[0-9a-f]{64}$' and length(sha256)=64 and sha256 is not null and finalized_at is not null)
 or (status<>'ready' and byte_count is null and verified_mime is null and sha256 is null and finalized_at is null));
update storage.buckets set allowed_mime_types=allowed_mime_types||array['application/pdf'] where id='catalogue-uploads';

create table public.extraction_runs (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id),
 source_file_id uuid not null, created_by uuid not null default auth.uid() references auth.users(id),
 status text not null default 'queued' check(status in ('queued','running','ready','ocr_required','failed')),
 configuration jsonb not null check(jsonb_typeof(configuration)='object'),
 config_digest text not null, payload jsonb, raw_pages jsonb,
 result_digest text, failure_reason jsonb, completed_pages integer not null default 0, total_pages integer,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(tenant_id,id),unique(tenant_id,id,source_file_id),unique(tenant_id,source_file_id,config_digest),
 foreign key(tenant_id,source_file_id) references public.source_files(tenant_id,id),
 check(completed_pages>=0 and (total_pages is null or (total_pages>=completed_pages and total_pages between 1 and 50))),
 check((status in ('ready','ocr_required'))=(payload is not null and result_digest is not null))
);
create table public.correction_revisions (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id),
 extraction_run_id uuid not null, source_file_id uuid not null, revision integer not null check(revision>0),
 configuration jsonb not null check(jsonb_typeof(configuration)='object'),
 corrections jsonb not null check(jsonb_typeof(corrections)='object'), confirmed boolean not null,
 created_by uuid not null default auth.uid() references auth.users(id),created_at timestamptz not null default now(),
 unique(tenant_id,id),unique(tenant_id,id,source_file_id),unique(extraction_run_id,revision),
 foreign key(tenant_id,extraction_run_id,source_file_id) references public.extraction_runs(tenant_id,id,source_file_id)
);
create index extraction_source on public.extraction_runs(tenant_id,source_file_id,created_at);
create index correction_extraction on public.correction_revisions(tenant_id,extraction_run_id,revision);
do $$ declare t text; begin
 foreach t in array array['extraction_runs','correction_revisions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated,service_role',t);
  execute format('create policy tenant_read on public.%I for select to authenticated using (private.has_role(tenant_id,array[''owner'',''editor'',''viewer'']))',t);
 end loop;
end $$;
create function private.guard_pdf_evidence() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='correction_revisions' then
  raise exception 'Correction revisions are immutable' using errcode='23514'; end if;
 if old.payload is not null or tg_op='DELETE' then
  raise exception 'Extracted evidence and correction revisions are immutable' using errcode='23514'; end if;
 if (new.id,new.tenant_id,new.source_file_id,new.configuration,new.created_by,new.config_digest) is distinct from
    (old.id,old.tenant_id,old.source_file_id,old.configuration,old.created_by,old.config_digest) then
  raise exception 'Extraction identity is immutable' using errcode='23514'; end if;
 new.updated_at=clock_timestamp(); return new;
end $$;
create trigger immutable_extraction before update or delete on public.extraction_runs for each row execute function private.guard_pdf_evidence();
create trigger immutable_correction before update or delete on public.correction_revisions for each row execute function private.guard_pdf_evidence();
alter table public.jobs alter column comparison_run_id drop not null;
alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add column extraction_run_id uuid unique;
alter table public.jobs add foreign key(tenant_id,extraction_run_id) references public.extraction_runs(tenant_id,id);
alter table public.jobs add constraint jobs_kind_check check (
 (kind='reconcile_csv' and comparison_run_id is not null and extraction_run_id is null)
 or (kind='extract_pdf' and comparison_run_id is null and extraction_run_id is not null));
alter table public.comparison_runs add column current_revision_id uuid;
alter table public.comparison_runs add column incoming_revision_id uuid;
alter table public.comparison_runs add foreign key(tenant_id,current_revision_id,current_file_id) references public.correction_revisions(tenant_id,id,source_file_id);
alter table public.comparison_runs add foreign key(tenant_id,incoming_revision_id,incoming_file_id) references public.correction_revisions(tenant_id,id,source_file_id);

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
  return to_jsonb(j);
end $$;

create or replace function private.enqueue_comparison_job(p_tenant uuid,p_comparison uuid,p_key text,
  p_current_options jsonb,p_incoming_options jsonb,p_max_attempts integer default 3)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; r public.comparison_runs; a uuid; b uuid;
  ar uuid; br uuid;
  config jsonb=jsonb_build_object('current',p_current_options,'incoming',p_incoming_options);
begin
  if not private.has_role(p_tenant,array['owner','editor']) then
    raise exception 'Editor membership required' using errcode='42501';
  end if;
  if p_key is null or length(p_key) not between 1 and 200 or p_max_attempts not between 1 and 10
    or p_max_attempts is null or length(config::text)>16384
    or jsonb_typeof(p_current_options) is distinct from 'object'
    or jsonb_typeof(p_incoming_options) is distinct from 'object'
    or (coalesce(p_current_options->>'format','csv')<>'pdf' and not (p_current_options ?& array['encoding','delimiter','columns','decimal_separator']))
    or (coalesce(p_incoming_options->>'format','csv')<>'pdf' and not (p_incoming_options ?& array['encoding','delimiter','columns','decimal_separator'])) then
    raise exception 'Explicit CSV settings and valid retry policy required' using errcode='23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||p_key,0));
  perform 1 from public.comparisons where tenant_id=p_tenant and id=p_comparison for update;
  if not found then raise exception 'Comparison outside tenant' using errcode='42501'; end if;
  select source_file_id into a from public.comparison_files
    where tenant_id=p_tenant and comparison_id=p_comparison and side='current';
  select source_file_id into b from public.comparison_files
    where tenant_id=p_tenant and comparison_id=p_comparison and side='incoming';
  if a is null or b is null or a=b or
    (select count(*) from public.source_files where tenant_id=p_tenant and id in (a,b)
      and status='ready' and verified_mime in ('text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/pdf'))<>2 then
    raise exception 'Two ready same-tenant CSV/XLSX inputs required' using errcode='23514';
  end if;
  if exists (
    select 1 from public.source_files f
    cross join lateral (select case when f.id=a then p_current_options else p_incoming_options end as o) q
    where f.tenant_id=p_tenant and f.id in (a,b)
      and ((f.verified_mime='text/csv' and coalesce(q.o->>'format','csv')<>'csv')
        or (f.verified_mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and
          (q.o->>'format' is distinct from 'xlsx' or
           jsonb_typeof(q.o->'worksheet') is distinct from 'string' or
           length(q.o->>'worksheet') not between 1 and 31 or
           jsonb_typeof(q.o->'header_row') is distinct from 'number' or
           coalesce(q.o->>'header_row','') !~ '^[1-9][0-9]{0,2}$' or
           (q.o->>'header_row')::int>200)))
  ) then raise exception 'Explicit file format, worksheet and header row required' using errcode='23514'; end if;
  ar=null; br=null;
  if (select verified_mime from public.source_files where tenant_id=p_tenant and id=a)='application/pdf' then
    if p_current_options->>'format' is distinct from 'pdf' then raise exception 'Confirmed PDF revision required' using errcode='23514'; end if;
    ar=(p_current_options->>'revision_id')::uuid;
    perform 1 from public.correction_revisions where tenant_id=p_tenant and id=ar and source_file_id=a and confirmed;
    if ar is null or not found then raise exception 'Confirmed PDF revision outside source/tenant' using errcode='42501'; end if;
  elsif p_current_options->>'format'='pdf' then raise exception 'PDF settings require PDF source' using errcode='23514'; end if;
  if (select verified_mime from public.source_files where tenant_id=p_tenant and id=b)='application/pdf' then
    if p_incoming_options->>'format' is distinct from 'pdf' then raise exception 'Confirmed PDF revision required' using errcode='23514'; end if;
    br=(p_incoming_options->>'revision_id')::uuid;
    perform 1 from public.correction_revisions where tenant_id=p_tenant and id=br and source_file_id=b and confirmed;
    if br is null or not found then raise exception 'Confirmed PDF revision outside source/tenant' using errcode='42501'; end if;
  elsif p_incoming_options->>'format'='pdf' then raise exception 'PDF settings require PDF source' using errcode='23514'; end if;
  select * into j from public.jobs where tenant_id=p_tenant and idempotency_key=p_key;
  if found then
    select * into r from public.comparison_runs where tenant_id=p_tenant and id=j.comparison_run_id;
    if (r.comparison_id,r.current_file_id,r.incoming_file_id,r.configuration,j.max_attempts)
      is distinct from (p_comparison,a,b,config,p_max_attempts) then
      raise exception 'Idempotency key reused for different inputs' using errcode='23514';
    end if;
    return to_jsonb(j);
  end if;
  insert into public.comparison_runs(tenant_id,comparison_id,current_file_id,incoming_file_id,configuration,current_revision_id,incoming_revision_id)
    values(p_tenant,p_comparison,a,b,config,ar,br) returning * into r;
  insert into public.jobs(tenant_id,comparison_run_id,idempotency_key,max_attempts)
    values(p_tenant,r.id,p_key,p_max_attempts) returning * into j;
  return to_jsonb(j);
end $$;

create or replace function private.load_csv_job(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; r public.comparison_runs; a public.source_files; b public.source_files;
begin
  j=private.leased_job(p_tenant,p_job,p_worker,p_token);
  select * into strict r from public.comparison_runs where tenant_id=p_tenant and id=j.comparison_run_id;
  select * into strict a from public.source_files where tenant_id=p_tenant and id=r.current_file_id;
  select * into strict b from public.source_files where tenant_id=p_tenant and id=r.incoming_file_id;
  if a.status<>'ready' or b.status<>'ready' or a.verified_mime not in ('text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/pdf') or b.verified_mime not in ('text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/pdf') then
    raise exception 'Ready CSV inputs required' using errcode='23514'; end if;
  return jsonb_build_object('run',to_jsonb(r),'current',to_jsonb(a),'incoming',to_jsonb(b),
    'current_revision',(select to_jsonb(v)||jsonb_build_object('extraction',e.payload) from public.correction_revisions v join public.extraction_runs e on e.tenant_id=v.tenant_id and e.id=v.extraction_run_id where v.tenant_id=p_tenant and v.id=r.current_revision_id and v.source_file_id=a.id and v.confirmed),
    'incoming_revision',(select to_jsonb(v)||jsonb_build_object('extraction',e.payload) from public.correction_revisions v join public.extraction_runs e on e.tenant_id=v.tenant_id and e.id=v.extraction_run_id where v.tenant_id=p_tenant and v.id=r.incoming_revision_id and v.source_file_id=b.id and v.confirmed));
end $$;

create function private.enqueue_pdf_extraction(p_tenant uuid,p_file uuid,p_configuration jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.extraction_runs; j public.jobs; digest text;
begin
 if not private.has_role(p_tenant,array['owner','editor']) then raise exception 'Editor required' using errcode='42501'; end if;
 if jsonb_typeof(p_configuration) is distinct from 'object' or
    (p_configuration - array['first_page','last_page','strategy'])<>'{}'::jsonb or
    jsonb_typeof(p_configuration->'first_page') is distinct from 'number' or
    jsonb_typeof(p_configuration->'last_page') is distinct from 'number' or
    coalesce(p_configuration->>'first_page','') !~ '^[1-9][0-9]{0,3}$' or
    coalesce(p_configuration->>'last_page','') !~ '^[1-9][0-9]{0,3}$' or
    (p_configuration->>'last_page')::int<(p_configuration->>'first_page')::int or
    (p_configuration->>'last_page')::int-(p_configuration->>'first_page')::int>=50 or
    coalesce(p_configuration->>'strategy','') not in ('lines','text') then
  raise exception 'Choose an explicit page range of at most 50 pages and table strategy' using errcode='23514'; end if;
 perform 1 from public.source_files where tenant_id=p_tenant and id=p_file and status='ready' and verified_mime='application/pdf';
 if not found then raise exception 'Ready PDF outside tenant' using errcode='42501'; end if;
 digest=encode(extensions.digest(p_configuration::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||p_file::text||digest,0));
 select * into e from public.extraction_runs where tenant_id=p_tenant and source_file_id=p_file and config_digest=digest;
 if found then select * into j from public.jobs where tenant_id=p_tenant and extraction_run_id=e.id;
 else
  insert into public.extraction_runs(tenant_id,source_file_id,configuration,config_digest) values(p_tenant,p_file,p_configuration,digest) returning * into e;
  insert into public.jobs(tenant_id,kind,extraction_run_id,idempotency_key) values(p_tenant,'extract_pdf',e.id,'pdf:'||e.id) returning * into j;
 end if;
 return jsonb_build_object('extraction',to_jsonb(e),'job',to_jsonb(j));
end $$;
create function private.load_pdf_extraction(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; e public.extraction_runs; f public.source_files;
begin
 j=private.leased_job(p_tenant,p_job,p_worker,p_token);
 if j.kind<>'extract_pdf' then raise exception 'PDF job required' using errcode='23514'; end if;
 select * into strict e from public.extraction_runs where tenant_id=p_tenant and id=j.extraction_run_id;
 select * into strict f from public.source_files where tenant_id=p_tenant and id=e.source_file_id and status='ready' and verified_mime='application/pdf';
 return jsonb_build_object('extraction',to_jsonb(e),'file',to_jsonb(f));
end $$;
create function private.pdf_extraction_progress(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,p_completed integer,p_total integer)
returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;
begin
 j=private.leased_job(p_tenant,p_job,p_worker,p_token);
 if j.kind<>'extract_pdf' or p_completed is null or p_total is null or p_completed<0 or p_total not between 1 and 50 or p_completed>p_total then raise exception 'Invalid progress' using errcode='23514'; end if;
 update public.extraction_runs set completed_pages=p_completed,total_pages=p_total where tenant_id=p_tenant and id=j.extraction_run_id;
end $$;
create function private.complete_pdf_extraction(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,p_payload jsonb,p_pages jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; e public.extraction_runs; digest text; state text;
begin
 select * into j from public.jobs where tenant_id=p_tenant and id=p_job for update;
 if not found or j.kind<>'extract_pdf' then raise exception 'PDF job outside tenant' using errcode='42501'; end if;
 select * into strict e from public.extraction_runs where tenant_id=p_tenant and id=j.extraction_run_id;
 if jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_pages) is distinct from 'array' or length(p_payload::text)+length(p_pages::text)>16777216 or
    p_payload->>'tenant_id' is distinct from p_tenant::text or p_payload->>'file_id' is distinct from e.source_file_id::text or p_payload->>'job_id' is distinct from p_job::text or
    p_payload->>'schema_version' is distinct from 'v1' or jsonb_typeof(p_payload->'records') is distinct from 'array' or jsonb_typeof(p_payload->'evidence') is distinct from 'array' or
    coalesce(p_payload#>>'{completion,state}','') not in ('complete','incomplete') then raise exception 'Invalid PDF extraction envelope' using errcode='23514'; end if;
 if p_payload#>>'{raw_artifact,bucket}' is distinct from 'catalogue-uploads' or
    p_payload#>>'{raw_artifact,object_key}' is distinct from (p_tenant::text||'/'||e.source_file_id::text||'/original') or
    exists(select 1 from jsonb_array_elements(p_payload->'evidence') f where f->>'source_file_id' is distinct from e.source_file_id::text or
      not exists(select 1 from jsonb_array_elements(p_payload->'records') r where r->>'record_id'=f->>'record_id')) then
  raise exception 'Evidence outside extraction source' using errcode='42501'; end if;
 digest=encode(extensions.digest(p_payload::text||p_pages::text,'sha256'),'hex');
 if j.status='succeeded' and j.completed_lease_token=p_token and exists(select 1 from public.job_attempts where tenant_id=p_tenant and job_id=p_job and lease_token=p_token and lease_owner=p_worker) then
  if e.result_digest is distinct from digest then raise exception 'Conflicting extraction completion' using errcode='23514'; end if;
  return to_jsonb(e);
 end if;
 j=private.leased_job(p_tenant,p_job,p_worker,p_token);
 state=case when p_payload#>>'{completion,state}'='complete' then 'ready' else 'ocr_required' end;
 update public.extraction_runs set status=state,payload=p_payload,raw_pages=p_pages,result_digest=digest,
  completed_pages=(p_payload#>>'{completion,completed_units}')::integer,total_pages=(p_payload#>>'{completion,total_units}')::integer,failure_reason=null
  where tenant_id=p_tenant and id=e.id returning * into e;
 update public.job_attempts set status='succeeded',finished_at=clock_timestamp() where tenant_id=p_tenant and job_id=p_job and lease_token=p_token;
 update public.jobs set status='succeeded',completed_lease_token=p_token,lease_owner=null,lease_token=null,lease_expires_at=null where tenant_id=p_tenant and id=p_job;
 return to_jsonb(e);
end $$;
create function private.save_pdf_revision(p_tenant uuid,p_extraction uuid,p_expected integer,p_configuration jsonb,p_corrections jsonb,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.extraction_runs; v public.correction_revisions; n integer; entry record; field record;
begin
 if not private.has_role(p_tenant,array['owner','editor']) then raise exception 'Editor required' using errcode='42501'; end if;
 select * into e from public.extraction_runs where tenant_id=p_tenant and id=p_extraction for update;
 if not found or e.status<>'ready' then raise exception 'Ready extraction outside tenant' using errcode='42501'; end if;
 select coalesce(max(revision),0) into n from public.correction_revisions where tenant_id=p_tenant and extraction_run_id=e.id;
 if p_expected is distinct from n then raise exception 'Revision changed; refresh before saving' using errcode='23514'; end if;
 if p_confirmed is null or jsonb_typeof(p_configuration) is distinct from 'object' or jsonb_typeof(p_corrections) is distinct from 'object' or length(p_configuration::text)>16384 or length(p_corrections::text)>1048576 or
   (p_confirmed and (p_configuration->'structure_confirmed' is distinct from 'true'::jsonb or
    jsonb_typeof(p_configuration->'table_index') is distinct from 'number' or
    jsonb_typeof(p_configuration->'header_row') is distinct from 'number' or
    jsonb_typeof(p_configuration->'repeat_headers') is distinct from 'boolean' or
    coalesce(p_configuration->>'table_index','') !~ '^[1-9][0-9]{0,1}$' or
    coalesce(p_configuration->>'header_row','') !~ '^[1-9][0-9]{0,2}$' or
    jsonb_typeof(p_configuration->'columns') is distinct from 'object' or
    not (p_configuration->'columns' ?& array['supplier_sku','cost_price']))) then
  raise exception 'Explicit table, header, mapping and structure confirmation required' using errcode='23514'; end if;
 for entry in select * from jsonb_each(p_corrections) loop
  if not exists(select 1 from jsonb_array_elements(e.payload->'records') r where r->>'record_id'=entry.key) or jsonb_typeof(entry.value)<>'object' or
   (entry.value-array['supplier_sku','description','cost_price','currency','pack_quantity','unit'])<>'{}'::jsonb then raise exception 'Correction outside extracted fields' using errcode='23514'; end if;
  for field in select * from jsonb_each(entry.value) loop
   if jsonb_typeof(field.value) not in ('string','null') or length(field.value::text)>10000 then raise exception 'Invalid correction value' using errcode='23514'; end if;
   if field.key='supplier_sku' and (jsonb_typeof(field.value)<>'string' or length(trim(field.value#>>'{}')) not between 1 and 500) then raise exception 'Identifier correction cannot be blank' using errcode='23514'; end if;
   if field.key in ('cost_price','pack_quantity') and jsonb_typeof(field.value)='string' and ((field.value#>>'{}') !~ '^[0-9]+([.,][0-9]+)?$' or length(field.value#>>'{}')>128 or (field.key='pack_quantity' and (field.value#>>'{}') ~ '^0+([.,]0+)?$')) then raise exception 'Correct prices/quantities using plain decimal text' using errcode='23514'; end if;
   if field.key='currency' and jsonb_typeof(field.value)='string' and (field.value#>>'{}') !~ '^[A-Z]{3}$' then raise exception 'Use a three-letter currency' using errcode='23514'; end if;
  end loop;
 end loop;
 insert into public.correction_revisions(tenant_id,extraction_run_id,source_file_id,revision,configuration,corrections,confirmed)
 values(p_tenant,e.id,e.source_file_id,n+1,p_configuration,p_corrections,p_confirmed) returning * into v;
 return to_jsonb(v);
end $$;

create function public.enqueue_pdf_extraction(p_tenant uuid,p_file uuid,p_configuration jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.enqueue_pdf_extraction(p_tenant,p_file,p_configuration); $$;
revoke all on function public.enqueue_pdf_extraction(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_pdf_extraction(uuid,uuid,jsonb) to authenticated;
revoke all on function private.enqueue_pdf_extraction(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.enqueue_pdf_extraction(uuid,uuid,jsonb) to authenticated;

create function public.load_pdf_extraction(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.load_pdf_extraction(p_tenant,p_job,p_worker,p_token); $$;
revoke all on function public.load_pdf_extraction(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.load_pdf_extraction(uuid,uuid,uuid,uuid) to service_role;
revoke all on function private.load_pdf_extraction(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.load_pdf_extraction(uuid,uuid,uuid,uuid) to service_role;

create function public.pdf_extraction_progress(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,p_completed integer,p_total integer) returns void language sql security invoker set search_path='' as $$ select private.pdf_extraction_progress(p_tenant,p_job,p_worker,p_token,p_completed,p_total); $$;
revoke all on function public.pdf_extraction_progress(uuid,uuid,uuid,uuid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.pdf_extraction_progress(uuid,uuid,uuid,uuid,integer,integer) to service_role;
revoke all on function private.pdf_extraction_progress(uuid,uuid,uuid,uuid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function private.pdf_extraction_progress(uuid,uuid,uuid,uuid,integer,integer) to service_role;

create function public.complete_pdf_extraction(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,p_payload jsonb,p_pages jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.complete_pdf_extraction(p_tenant,p_job,p_worker,p_token,p_payload,p_pages); $$;
revoke all on function public.complete_pdf_extraction(uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.complete_pdf_extraction(uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;
revoke all on function private.complete_pdf_extraction(uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.complete_pdf_extraction(uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;

create function public.save_pdf_revision(p_tenant uuid,p_extraction uuid,p_expected integer,p_configuration jsonb,p_corrections jsonb,p_confirmed boolean) returns jsonb language sql security invoker set search_path='' as $$ select private.save_pdf_revision(p_tenant,p_extraction,p_expected,p_configuration,p_corrections,p_confirmed); $$;
revoke all on function public.save_pdf_revision(uuid,uuid,integer,jsonb,jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function public.save_pdf_revision(uuid,uuid,integer,jsonb,jsonb,boolean) to authenticated;
revoke all on function private.save_pdf_revision(uuid,uuid,integer,jsonb,jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function private.save_pdf_revision(uuid,uuid,integer,jsonb,jsonb,boolean) to authenticated;
revoke all on function private.guard_pdf_evidence() from public,anon,authenticated,service_role;
