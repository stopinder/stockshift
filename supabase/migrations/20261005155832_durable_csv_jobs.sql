begin;
create table public.comparison_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  comparison_id uuid not null,
  current_file_id uuid not null,
  incoming_file_id uuid not null,
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  result_count integer check (result_count >= 0),
  result_digest text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,id),
  foreign key (tenant_id,comparison_id) references public.comparisons(tenant_id,id),
  foreign key (tenant_id,current_file_id) references public.source_files(tenant_id,id),
  foreign key (tenant_id,incoming_file_id) references public.source_files(tenant_id,id),
  check (current_file_id <> incoming_file_id),
  check ((status='succeeded') = (result_count is not null and result_digest is not null))
);
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  comparison_run_id uuid not null unique,
  kind text not null default 'reconcile_csv' check (kind='reconcile_csv'),
  status text not null default 'queued'
    check (status in ('queued','running','retry_wait','succeeded','failed','dead_letter')),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  lease_owner uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  completed_lease_token uuid,
  available_at timestamptz not null default now(),
  failure_reason jsonb check (failure_reason is null or jsonb_typeof(failure_reason)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,id), unique (tenant_id,idempotency_key),
  foreign key (tenant_id,comparison_run_id) references public.comparison_runs(tenant_id,id),
  check (attempt_count <= max_attempts),
  check ((status='running' and lease_owner is not null and lease_token is not null
     and lease_expires_at is not null) or (status<>'running' and lease_owner is null
     and lease_token is null and lease_expires_at is null)),
  check ((status='succeeded') = (completed_lease_token is not null))
);
create index jobs_eligible on public.jobs(available_at,created_at)
  where status in ('queued','retry_wait','running');
create table public.job_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  job_id uuid not null,
  attempt_number integer not null check (attempt_number between 1 and 10),
  lease_owner uuid not null,
  lease_token uuid not null unique,
  status text not null check (status in ('running','succeeded','failed','expired')),
  failure_reason jsonb check (failure_reason is null or jsonb_typeof(failure_reason)='object'),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id,attempt_number), unique (tenant_id,id),
  foreign key (tenant_id,job_id) references public.jobs(tenant_id,id),
  check ((status='running') = (finished_at is null))
);
create table public.comparison_results (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  comparison_run_id uuid not null,
  source_result_id uuid not null,
  primary_outcome text not null check (primary_outcome in ('unchanged','changed','new','absent','needs_review')),
  review_state text not null check (review_state in ('not_required','pending')),
  change_flags jsonb not null check (jsonb_typeof(change_flags)='array'),
  old_values jsonb, new_values jsonb,
  cost_delta numeric, cost_delta_text text,
  cost_change_percent numeric, cost_change_percent_text text,
  percentage_state text not null check (percentage_state in ('defined','zero_old_cost','not_comparable')),
  reasons jsonb not null check (jsonb_typeof(reasons)='array'),
  provenance jsonb not null check (jsonb_typeof(provenance)='array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (comparison_run_id,source_result_id), unique (tenant_id,comparison_run_id,id),
  foreign key (tenant_id,comparison_run_id) references public.comparison_runs(tenant_id,id),
  check (old_values is not null or new_values is not null),
  check ((primary_outcome='needs_review') = (review_state='pending')),
  check (cost_delta is not distinct from cost_delta_text::numeric),
  check (cost_change_percent is not distinct from cost_change_percent_text::numeric),
  check ((percentage_state='defined') = (cost_change_percent is not null))
);
create table public.match_candidates (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  comparison_run_id uuid not null,
  comparison_result_id uuid not null unique,
  status text not null default 'pending' check (status='pending'),
  basis text not null check (basis in ('exact_sku_review','unpaired_review')),
  candidate_data jsonb not null check (jsonb_typeof(candidate_data)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id,comparison_run_id,comparison_result_id)
    references public.comparison_results(tenant_id,comparison_run_id,id)
);
create index results_tenant_run on public.comparison_results(tenant_id,comparison_run_id);
create index attempts_tenant_job on public.job_attempts(tenant_id,job_id);
create index candidates_tenant_run on public.match_candidates(tenant_id,comparison_run_id);

create function private.touch_job_row() returns trigger language plpgsql set search_path='' as $$
begin
  if (new.id,new.tenant_id) is distinct from (old.id,old.tenant_id) then
    raise exception 'Tenant and identity are immutable' using errcode='23514';
  end if;
  new.updated_at=clock_timestamp(); return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['jobs','job_attempts','comparison_runs','comparison_results','match_candidates'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on public.%I to authenticated,service_role',t);
    execute format('create policy tenant_read on public.%I for select to authenticated
      using (private.has_role(tenant_id,array[''owner'',''editor'',''viewer'']))',t);
    execute format('create trigger touch_job_row before update on public.%I
      for each row execute function private.touch_job_row()',t);
  end loop;
end $$;

create function private.enqueue_comparison_job(p_tenant uuid,p_comparison uuid,p_key text,
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
      and status='ready' and verified_mime='text/csv')<>2 then
    raise exception 'Two ready same-tenant CSV inputs required' using errcode='23514';
  end if;
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

create function private.claim_csv_job(p_worker uuid,p_lease_seconds integer default 120)
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
    return to_jsonb(j);
  end loop;
end $$;

create function private.leased_job(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid)
returns public.jobs language plpgsql security definer set search_path='' as $$
declare j public.jobs;
begin
  select * into j from public.jobs where tenant_id=p_tenant and id=p_job for update;
  if not found or j.status<>'running' or j.lease_owner is distinct from p_worker
    or j.lease_token is distinct from p_token or j.lease_expires_at<=clock_timestamp() then
    raise exception 'Worker lease is stale or outside tenant' using errcode='42501';
  end if;
  return j;
end $$;
create function private.heartbeat_csv_job(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,
  p_lease_seconds integer default 120) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare j public.jobs; expiry timestamptz;
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'Invalid lease duration' using errcode='23514'; end if;
  j=private.leased_job(p_tenant,p_job,p_worker,p_token);
  update public.jobs set lease_expires_at=greatest(lease_expires_at,
    clock_timestamp()+make_interval(secs=>p_lease_seconds)) where id=j.id
    returning lease_expires_at into expiry;
  return expiry;
end $$;
create function private.load_csv_job(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; r public.comparison_runs; a public.source_files; b public.source_files;
begin
  j=private.leased_job(p_tenant,p_job,p_worker,p_token);
  select * into strict r from public.comparison_runs where tenant_id=p_tenant and id=j.comparison_run_id;
  select * into strict a from public.source_files where tenant_id=p_tenant and id=r.current_file_id;
  select * into strict b from public.source_files where tenant_id=p_tenant and id=r.incoming_file_id;
  if a.status<>'ready' or b.status<>'ready' or a.verified_mime<>'text/csv' or b.verified_mime<>'text/csv' then
    raise exception 'Ready CSV inputs required' using errcode='23514'; end if;
  return jsonb_build_object('run',to_jsonb(r),'current',to_jsonb(a),'incoming',to_jsonb(b));
end $$;
create function private.fail_csv_job(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,
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
  return to_jsonb(j);
end $$;

create function private.complete_csv_job(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,
  p_results jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; r public.comparison_runs; item jsonb; value jsonb; evidence jsonb;
  digest text=encode(sha256(convert_to(p_results::text,'UTF8')),'hex');
begin
  select * into j from public.jobs where tenant_id=p_tenant and id=p_job for update;
  if not found then raise exception 'Job outside tenant' using errcode='42501'; end if;
  select * into strict r from public.comparison_runs where tenant_id=p_tenant and id=j.comparison_run_id;
  if j.status='succeeded' and j.completed_lease_token=p_token and exists (
    select 1 from public.job_attempts where tenant_id=p_tenant and job_id=j.id
      and lease_token=p_token and lease_owner=p_worker) then
    if r.result_digest is distinct from digest then
      raise exception 'Completion payload changed' using errcode='23514'; end if;
    return to_jsonb(j);
  end if;
  j=private.leased_job(p_tenant,p_job,p_worker,p_token);
  if jsonb_typeof(p_results) is distinct from 'array' or jsonb_array_length(p_results)>20000 then
    raise exception 'Bounded results array required' using errcode='23514'; end if;
  for item in select * from jsonb_array_elements(p_results) loop
    if not (item ?& array['id','source_result_id','outcome','review_state','change_flags',
      'old_values','new_values','cost_delta','cost_change_percent','percentage_state','reasons','provenance'])
      or jsonb_typeof(item->'reasons') is distinct from 'array'
      or jsonb_typeof(item->'provenance') is distinct from 'array'
      or jsonb_typeof(item->'change_flags') is distinct from 'array'
      or (item->>'cost_delta' is not null and jsonb_typeof(item->'cost_delta')<>'string')
      or (item->>'cost_change_percent' is not null and jsonb_typeof(item->'cost_change_percent')<>'string')
      or (item->>'cost_delta' is not null and item->>'cost_delta' !~ '^-?[0-9]+(\.[0-9]+)?$')
      or (item->>'cost_change_percent' is not null and item->>'cost_change_percent' !~ '^-?[0-9]+(\.[0-9]+)?$') then
      raise exception 'Invalid result structure' using errcode='23514'; end if;
    for value in select x from (values(item->'old_values'),(item->'new_values')) v(x) loop
      if value<>'null'::jsonb and (jsonb_typeof(value)<>'object'
        or not (value ?& array['source_file_id','record_id','schema_version','evidence_ids'])
        or value->>'schema_version' is distinct from 'v1'
        or value->>'record_id' is null
        or jsonb_typeof(value->'evidence_ids') is distinct from 'array') then
        raise exception 'Invalid normalized value' using errcode='23514'; end if;
    end loop;
    if (item->'old_values'<>'null'::jsonb and item->'old_values'->>'source_file_id' is distinct from r.current_file_id::text)
      or (item->'new_values'<>'null'::jsonb and item->'new_values'->>'source_file_id' is distinct from r.incoming_file_id::text) then
      raise exception 'Result source outside run' using errcode='23514'; end if;
    for evidence in select * from jsonb_array_elements(item->'provenance') loop
      if not (evidence ?& array['source_file_id','record_id','evidence_id','locator'])
        or evidence->>'source_file_id' is null
        or evidence->>'source_file_id' not in (r.current_file_id::text,r.incoming_file_id::text)
        or not exists (select 1 from (values(item->'old_values'),(item->'new_values')) records(v)
          where v->>'source_file_id'=evidence->>'source_file_id'
            and v->>'record_id'=evidence->>'record_id'
            and v->'evidence_ids' ? (evidence->>'evidence_id')) then
        raise exception 'Evidence source outside run' using errcode='23514'; end if;
    end loop;
    insert into public.comparison_results(id,tenant_id,comparison_run_id,source_result_id,
      primary_outcome,review_state,change_flags,old_values,new_values,cost_delta,cost_delta_text,
      cost_change_percent,cost_change_percent_text,percentage_state,reasons,provenance)
    values((item->>'id')::uuid,p_tenant,r.id,(item->>'source_result_id')::uuid,
      item->>'outcome',item->>'review_state',item->'change_flags',nullif(item->'old_values','null'),
      nullif(item->'new_values','null'),(item->>'cost_delta')::numeric,item->>'cost_delta',
      (item->>'cost_change_percent')::numeric,item->>'cost_change_percent',
      item->>'percentage_state',item->'reasons',item->'provenance');
    if item->>'outcome'='needs_review' then
      insert into public.match_candidates(id,tenant_id,comparison_run_id,comparison_result_id,basis,candidate_data)
      values((item->>'id')::uuid,p_tenant,r.id,(item->>'id')::uuid,
        case when item->'old_values'<>'null' and item->'new_values'<>'null'
          then 'exact_sku_review' else 'unpaired_review' end,
        jsonb_build_object('old_record',item->'old_values','new_record',item->'new_values',
          'reasons',item->'reasons','score',null));
    end if;
  end loop;
  if j.lease_expires_at<=clock_timestamp() then
    raise exception 'Lease expired during persistence' using errcode='42501'; end if;
  update public.comparison_runs set status='succeeded',result_count=jsonb_array_length(p_results),
    result_digest=digest where tenant_id=p_tenant and id=r.id;
  update public.job_attempts set status='succeeded',finished_at=clock_timestamp()
    where tenant_id=p_tenant and job_id=j.id and lease_token=p_token;
  update public.jobs set status='succeeded',completed_lease_token=p_token,lease_owner=null,
    lease_token=null,lease_expires_at=null where id=j.id returning * into j;
  return to_jsonb(j);
end $$;

-- Browser enqueues through a constrained tenant-aware function; workers alone mutate leases/results.
create function public.enqueue_comparison_job(p_tenant uuid,p_comparison uuid,p_key text,
  p_current_options jsonb,p_incoming_options jsonb,p_max_attempts integer default 3)
returns jsonb language sql security invoker set search_path='' as $$
  select private.enqueue_comparison_job(p_tenant,p_comparison,p_key,p_current_options,p_incoming_options,p_max_attempts);
$$;
create function public.claim_csv_job(p_worker uuid,p_lease_seconds integer default 120)
returns jsonb language sql security invoker set search_path='' as $$
  select private.claim_csv_job(p_worker,p_lease_seconds);
$$;
create function public.heartbeat_csv_job(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,
  p_lease_seconds integer default 120) returns timestamptz language sql security invoker set search_path='' as $$
  select private.heartbeat_csv_job(p_tenant,p_job,p_worker,p_token,p_lease_seconds);
$$;
create function public.load_csv_job(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select private.load_csv_job(p_tenant,p_job,p_worker,p_token);
$$;
create function public.fail_csv_job(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,
  p_failure jsonb,p_retryable boolean) returns jsonb language sql security invoker set search_path='' as $$
  select private.fail_csv_job(p_tenant,p_job,p_worker,p_token,p_failure,p_retryable);
$$;
create function public.complete_csv_job(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,p_results jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select private.complete_csv_job(p_tenant,p_job,p_worker,p_token,p_results);
$$;
revoke all on function private.enqueue_comparison_job(uuid,uuid,text,jsonb,jsonb,integer) from public,anon,service_role;
grant execute on function private.enqueue_comparison_job(uuid,uuid,text,jsonb,jsonb,integer) to authenticated;
revoke all on function private.claim_csv_job(uuid,integer) from public,anon,authenticated;
revoke all on function private.heartbeat_csv_job(uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function private.load_csv_job(uuid,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function private.fail_csv_job(uuid,uuid,uuid,uuid,jsonb,boolean) from public,anon,authenticated;
revoke all on function private.complete_csv_job(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.claim_csv_job(uuid,integer) to service_role;
grant execute on function private.heartbeat_csv_job(uuid,uuid,uuid,uuid,integer) to service_role;
grant execute on function private.load_csv_job(uuid,uuid,uuid,uuid) to service_role;
grant execute on function private.fail_csv_job(uuid,uuid,uuid,uuid,jsonb,boolean) to service_role;
grant execute on function private.complete_csv_job(uuid,uuid,uuid,uuid,jsonb) to service_role;
revoke all on function private.touch_job_row() from public,anon,authenticated,service_role;
revoke all on function private.leased_job(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.enqueue_comparison_job(uuid,uuid,text,jsonb,jsonb,integer) from public,anon,service_role;
grant execute on function public.enqueue_comparison_job(uuid,uuid,text,jsonb,jsonb,integer) to authenticated;
revoke all on function public.claim_csv_job(uuid,integer) from public,anon,authenticated;
revoke all on function public.heartbeat_csv_job(uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.load_csv_job(uuid,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.fail_csv_job(uuid,uuid,uuid,uuid,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.complete_csv_job(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.claim_csv_job(uuid,integer) to service_role;
grant execute on function public.heartbeat_csv_job(uuid,uuid,uuid,uuid,integer) to service_role;
grant execute on function public.load_csv_job(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.fail_csv_job(uuid,uuid,uuid,uuid,jsonb,boolean) to service_role;
grant execute on function public.complete_csv_job(uuid,uuid,uuid,uuid,jsonb) to service_role;
commit;
