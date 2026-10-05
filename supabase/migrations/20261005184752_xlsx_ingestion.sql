-- Extend supported structured files; existing tenant ownership and job fencing remain.
alter table public.source_files drop constraint source_files_original_filename_check;
alter table public.source_files add constraint source_files_original_filename_check check (
 length(original_filename) between 1 and 255 and original_filename !~ '[/\\]'
 and original_filename !~ '[[:cntrl:]]' and lower(original_filename) ~ '\.(csv|xlsx)$');
alter table public.source_files drop constraint source_files_check;
alter table public.source_files add constraint source_files_check check (
 (status='ready' and byte_count=expected_byte_count and byte_count is not null
 and verified_mime is not null and ((lower(original_filename) ~ '\.csv$' and verified_mime='text/csv')
 or (lower(original_filename) ~ '\.xlsx$' and verified_mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
 and sha256 ~ '^[0-9a-f]{64}$' and length(sha256)=64 and sha256 is not null and finalized_at is not null)
 or (status<>'ready' and byte_count is null and verified_mime is null and sha256 is null and finalized_at is null));
update storage.buckets set allowed_mime_types=array['text/csv','application/octet-stream','application/vnd.ms-excel',
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] where id='catalogue-uploads';

create or replace function private.enqueue_comparison_job(p_tenant uuid,p_comparison uuid,p_key text,
  p_current_options jsonb,p_incoming_options jsonb,p_max_attempts integer default 3)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; r public.comparison_runs; a uuid; b uuid;
  config jsonb=jsonb_build_object('current',p_current_options,'incoming',p_incoming_options);
begin
  if not private.has_role(p_tenant,array['owner','editor']) then
    raise exception 'Editor membership required' using errcode='42501';
  end if;
  if p_key is null or length(p_key) not between 1 and 200 or p_max_attempts not between 1 and 10
    or p_max_attempts is null or length(config::text)>16384
    or jsonb_typeof(p_current_options) is distinct from 'object'
    or jsonb_typeof(p_incoming_options) is distinct from 'object'
    or not (p_current_options ?& array['encoding','delimiter','columns','decimal_separator'])
    or not (p_incoming_options ?& array['encoding','delimiter','columns','decimal_separator']) then
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
      and status='ready' and verified_mime in ('text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))<>2 then
    raise exception 'Two ready same-tenant CSV/XLSX inputs required' using errcode='23514';
  end if;
  if exists (
    select 1 from public.source_files f
    cross join lateral (select case when f.id=a then p_current_options else p_incoming_options end as o) q
    where f.tenant_id=p_tenant and f.id in (a,b)
      and ((f.verified_mime='text/csv' and coalesce(q.o->>'format','csv')<>'csv')
        or (f.verified_mime<>'text/csv' and
          (q.o->>'format' is distinct from 'xlsx' or
           jsonb_typeof(q.o->'worksheet') is distinct from 'string' or
           length(q.o->>'worksheet') not between 1 and 31 or
           jsonb_typeof(q.o->'header_row') is distinct from 'number' or
           coalesce(q.o->>'header_row','') !~ '^[1-9][0-9]{0,2}$' or
           (q.o->>'header_row')::int>200)))
  ) then raise exception 'Explicit file format, worksheet and header row required' using errcode='23514'; end if;
  select * into j from public.jobs where tenant_id=p_tenant and idempotency_key=p_key;
  if found then
    select * into r from public.comparison_runs where tenant_id=p_tenant and id=j.comparison_run_id;
    if (r.comparison_id,r.current_file_id,r.incoming_file_id,r.configuration,j.max_attempts)
      is distinct from (p_comparison,a,b,config,p_max_attempts) then
      raise exception 'Idempotency key reused for different inputs' using errcode='23514';
    end if;
    return to_jsonb(j);
  end if;
  insert into public.comparison_runs(tenant_id,comparison_id,current_file_id,incoming_file_id,configuration)
    values(p_tenant,p_comparison,a,b,config) returning * into r;
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
  if a.status<>'ready' or b.status<>'ready' or a.verified_mime not in ('text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') or b.verified_mime not in ('text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') then
    raise exception 'Ready CSV inputs required' using errcode='23514'; end if;
  return jsonb_build_object('run',to_jsonb(r),'current',to_jsonb(a),'incoming',to_jsonb(b));
end $$;
