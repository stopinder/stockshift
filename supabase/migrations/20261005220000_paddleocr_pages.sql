-- OCR cache/usage is worker-only; browser receives sanitized extraction evidence.
create table private.ocr_pages (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null, extraction_run_id uuid not null,
 source_file_id uuid not null, page integer not null check(page between 1 and 9999),
 request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
 status text not null check(status in ('requested','ready','failed')),
 request_count integer not null default 1 check(request_count between 1 and 3),
 last_lease uuid not null, response jsonb, response_digest text, failure_reason jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(tenant_id,extraction_run_id,page),
 foreign key(tenant_id,extraction_run_id,source_file_id) references public.extraction_runs(tenant_id,id,source_file_id),
 check((status='ready')=(response is not null and response_digest is not null))
);
alter table private.ocr_pages enable row level security;
revoke all on private.ocr_pages from public,anon,authenticated,service_role;
create function private.guard_ocr_cache() returns trigger language plpgsql set search_path='' as $$
begin
 if old.status='ready' or tg_op='DELETE' or (new.id,new.tenant_id,new.extraction_run_id,new.source_file_id,new.page,new.request_hash) is distinct from
 (old.id,old.tenant_id,old.extraction_run_id,old.source_file_id,old.page,old.request_hash) then
 raise exception 'OCR cache identity and completed evidence are immutable' using errcode='23514'; end if;
 new.updated_at=clock_timestamp(); return new;
end $$;
create trigger immutable_ocr_cache before update or delete on private.ocr_pages for each row execute function private.guard_ocr_cache();
revoke all on function private.guard_ocr_cache() from public,anon,authenticated,service_role;

create or replace function private.enqueue_pdf_extraction(p_tenant uuid,p_file uuid,p_configuration jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.extraction_runs; j public.jobs; digest text;
begin
 if not private.has_role(p_tenant,array['owner','editor']) then raise exception 'Editor required' using errcode='42501'; end if;
 if jsonb_typeof(p_configuration) is distinct from 'object' or
    (p_configuration - array['first_page','last_page','strategy','provider','model_version','dpi','ocr_version'])<>'{}'::jsonb or
    jsonb_typeof(p_configuration->'first_page') is distinct from 'number' or
    jsonb_typeof(p_configuration->'last_page') is distinct from 'number' or
    coalesce(p_configuration->>'first_page','') !~ '^[1-9][0-9]{0,3}$' or
    coalesce(p_configuration->>'last_page','') !~ '^[1-9][0-9]{0,3}$' or
    (p_configuration->>'last_page')::int<(p_configuration->>'first_page')::int or
    (p_configuration->>'last_page')::int-(p_configuration->>'first_page')::int>=50 or
    coalesce(p_configuration->>'strategy','') not in ('lines','text') then
  raise exception 'Choose an explicit page range of at most 50 pages and table strategy' using errcode='23514'; end if;
 if p_configuration ? 'provider' and (p_configuration->>'provider' is distinct from 'auto' or
 p_configuration->>'model_version' is null or length(p_configuration->>'model_version') not between 1 and 100 or
 p_configuration->>'ocr_version' is distinct from '1' or p_configuration->'dpi' is distinct from '144'::jsonb) then
 raise exception 'Explicit supported OCR provider/model/render configuration required' using errcode='23514'; end if;
 if not p_configuration ? 'provider' and p_configuration ?| array['model_version','dpi','ocr_version'] then
 raise exception 'OCR configuration requires explicit provider choice' using errcode='23514'; end if;
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
create or replace function private.load_pdf_extraction(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; e public.extraction_runs; f public.source_files;
begin
 j=private.leased_job(p_tenant,p_job,p_worker,p_token);
 if j.kind<>'extract_pdf' then raise exception 'PDF job required' using errcode='23514'; end if;
 select * into strict e from public.extraction_runs where tenant_id=p_tenant and id=j.extraction_run_id;
 select * into strict f from public.source_files where tenant_id=p_tenant and id=e.source_file_id and status='ready' and verified_mime='application/pdf';
 return jsonb_build_object('extraction',to_jsonb(e),'file',to_jsonb(f),'ocr_cache',(select coalesce(jsonb_object_agg(page::text,to_jsonb(c)),'{}'::jsonb) from private.ocr_pages c where c.tenant_id=p_tenant and c.extraction_run_id=e.id));
end $$;
create or replace function private.save_pdf_revision(p_tenant uuid,p_extraction uuid,p_expected integer,p_configuration jsonb,p_corrections jsonb,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.extraction_runs; v public.correction_revisions; n integer; entry record; field record;
begin
 if not private.has_role(p_tenant,array['owner','editor']) then raise exception 'Editor required' using errcode='42501'; end if;
 select * into e from public.extraction_runs where tenant_id=p_tenant and id=p_extraction for update;
 if not found or e.status<>'ready' then raise exception 'Ready extraction outside tenant' using errcode='42501'; end if;
 select coalesce(max(revision),0) into n from public.correction_revisions where tenant_id=p_tenant and extraction_run_id=e.id;
 if p_expected is distinct from n then raise exception 'Revision changed; refresh before saving' using errcode='23514'; end if;
 if p_confirmed is null or jsonb_typeof(p_configuration) is distinct from 'object' or jsonb_typeof(p_corrections) is distinct from 'object' or length(p_configuration::text)>1048576 or length(p_corrections::text)>1048576 or
   (p_confirmed and (p_configuration->'structure_confirmed' is distinct from 'true'::jsonb or
    jsonb_typeof(p_configuration->'table_index') is distinct from 'number' or
    jsonb_typeof(p_configuration->'header_row') is distinct from 'number' or
    jsonb_typeof(p_configuration->'repeat_headers') is distinct from 'boolean' or
    coalesce(p_configuration->>'table_index','') !~ '^[1-9][0-9]{0,1}$' or
    coalesce(p_configuration->>'header_row','') !~ '^[1-9][0-9]{0,2}$' or
    jsonb_typeof(p_configuration->'columns') is distinct from 'object' or
    not (p_configuration->'columns' ?& array['supplier_sku','cost_price']))) then
  raise exception 'Explicit table, header, mapping and structure confirmation required' using errcode='23514'; end if;
 if p_configuration ? 'ocr_verified_rows' and (jsonb_typeof(p_configuration->'ocr_verified_rows') is distinct from 'array' or
 exists(select 1 from jsonb_array_elements(p_configuration->'ocr_verified_rows') as verified(item) where jsonb_typeof(verified.item)<>'string' or not exists(select 1 from jsonb_array_elements(e.payload->'records') r where r->>'record_id'=verified.item#>>'{}'))) then
 raise exception 'OCR verification outside extracted rows' using errcode='23514'; end if;
 if p_confirmed and exists(
 select 1 from jsonb_array_elements(e.payload->'warnings') w
 join lateral (select r from jsonb_array_elements(e.payload->'records') r where r->>'record_id'=w->>'field') q on true
 join lateral (select f from jsonb_array_elements(e.payload->'evidence') f where f->>'record_id'=w->>'field' limit 1) z on true
 where w->>'code'='ocr_verification_required' and z.f#>>'{locator,table}'=p_configuration->>'table_index'
 and (z.f#>>'{locator,row}')::int>(p_configuration->>'header_row')::int
 and not coalesce((p_configuration->'repeat_headers'='true'::jsonb and jsonb_path_query_array(q.r,'$.raw_cells[*].value')=(
 select jsonb_path_query_array(hr,'$.raw_cells[*].value') from jsonb_array_elements(e.payload->'records') hr
 join lateral (select he from jsonb_array_elements(e.payload->'evidence') he where he->>'record_id'=hr->>'record_id' limit 1) hz on true
 where hz.he#>>'{locator,table}'=p_configuration->>'table_index' and hz.he#>>'{locator,row}'=p_configuration->>'header_row'
 order by (hz.he#>>'{locator,page}')::int limit 1)),false)
 and not coalesce(p_configuration->'ocr_verified_rows','[]'::jsonb) ? (w->>'field')) then
 raise exception 'Verify each selected OCR product row against its source before confirmation' using errcode='23514'; end if;
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

create function private.record_ocr_page(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,p_event text,p_page integer,p_hash text,p_value jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs; e public.extraction_runs; c private.ocr_pages; d text;
begin
 j=private.leased_job(p_tenant,p_job,p_worker,p_token);
 select * into strict e from public.extraction_runs where tenant_id=p_tenant and id=j.extraction_run_id;
 if j.kind<>'extract_pdf' or e.configuration->>'provider' is distinct from 'auto' or p_page is null or
 p_page<(e.configuration->>'first_page')::int or p_page>(e.configuration->>'last_page')::int or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
 or p_event is null or p_event not in ('request','ready','failed') or jsonb_typeof(p_value) is distinct from 'object' or length(p_value::text)>2000000 then
 raise exception 'Invalid OCR event or page selection' using errcode='23514'; end if;
 select * into c from private.ocr_pages where tenant_id=p_tenant and extraction_run_id=e.id and page=p_page for update;
 if found and c.request_hash<>p_hash then raise exception 'OCR render/config hash conflict' using errcode='23514'; end if;
 if p_event='request' then
  if c.status='ready' then return; end if;
  if c.id is not null and c.last_lease=p_token then return; end if;
  if c.id is not null and c.request_count>=3 then raise exception 'OCR page retry budget exhausted' using errcode='23514'; end if;
  if c.id is null and (select count(*) from private.ocr_pages where tenant_id=p_tenant and extraction_run_id=e.id)>=50 then
   raise exception 'OCR document page budget exhausted' using errcode='23514'; end if;
  insert into private.ocr_pages(tenant_id,extraction_run_id,source_file_id,page,request_hash,status,last_lease)
  values(p_tenant,e.id,e.source_file_id,p_page,p_hash,'requested',p_token)
  on conflict(tenant_id,extraction_run_id,page) do update set status='requested',last_lease=p_token,request_count=private.ocr_pages.request_count+1,failure_reason=null;
 else
  if c.id is null or c.last_lease<>p_token then raise exception 'OCR request must be authorized first' using errcode='42501'; end if;
  if p_event='ready' then
   if jsonb_typeof(p_value->'parsing_res_list') is distinct from 'array' then raise exception 'Invalid OCR block response' using errcode='23514'; end if;
   d=encode(extensions.digest(p_value::text,'sha256'),'hex');
   if c.status='ready' then
    if c.response_digest<>d then raise exception 'Conflicting OCR completion' using errcode='23514'; end if;
    return;
   end if;
   update private.ocr_pages set status='ready',response=p_value,response_digest=d,failure_reason=null where id=c.id;
  else
   if c.status='ready' then raise exception 'OCR evidence already complete' using errcode='23514'; end if;
   if jsonb_typeof(p_value->'code') is distinct from 'string' or jsonb_typeof(p_value->'message') is distinct from 'string' or jsonb_typeof(p_value->'retryable') is distinct from 'boolean' then
    raise exception 'Structured OCR failure required' using errcode='23514'; end if;
   update private.ocr_pages set status='failed',failure_reason=p_value where id=c.id;
  end if;
 end if;
 update public.extraction_runs set raw_pages=(
 select jsonb_agg(jsonb_build_object('page',page,'text','','provider','paddleocr-vl','status',status,
 'request_count',request_count,'message',failure_reason->>'message') order by page)
 from private.ocr_pages where tenant_id=p_tenant and extraction_run_id=e.id)
 where tenant_id=p_tenant and id=e.id;
end $$;
create function public.record_ocr_page(p_tenant uuid,p_job uuid,p_worker uuid,p_token uuid,p_event text,p_page integer,p_hash text,p_value jsonb)
returns void language sql security invoker set search_path='' as $$ select private.record_ocr_page(p_tenant,p_job,p_worker,p_token,p_event,p_page,p_hash,p_value); $$;
revoke all on function private.record_ocr_page(uuid,uuid,uuid,uuid,text,integer,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.record_ocr_page(uuid,uuid,uuid,uuid,text,integer,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.record_ocr_page(uuid,uuid,uuid,uuid,text,integer,text,jsonb) to service_role;
grant execute on function public.record_ocr_page(uuid,uuid,uuid,uuid,text,integer,text,jsonb) to service_role;
