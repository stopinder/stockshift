-- Explicit layout associations and fail-closed retail review, preserving lease/RLS boundaries.
create or replace function private.enqueue_pdf_extraction(p_tenant uuid,p_file uuid,p_configuration jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.extraction_runs; j public.jobs; digest text;
begin
 if not private.has_role(p_tenant,array['owner','editor']) then raise exception 'Editor required' using errcode='42501'; end if;
 if jsonb_typeof(p_configuration) is distinct from 'object' or
    (p_configuration - array['first_page','last_page','strategy','provider','model_version','dpi','ocr_version','layout_association'])<>'{}'::jsonb or
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
 if p_configuration ? 'layout_association' and (p_configuration->>'provider' is distinct from 'auto' or
 jsonb_typeof(p_configuration->'layout_association') is distinct from 'object' or
 p_configuration#>>'{layout_association,source_verified}' is distinct from 'true' or
 length((p_configuration->'layout_association')::text)>1048576) then
 raise exception 'Explicit source-verified layout association required' using errcode='23514'; end if;
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
 where w->>'code'='ocr_verification_required' and coalesce(q.r#>>'{semantic_candidates,layout_grid_table}',z.f#>>'{locator,table}')=p_configuration->>'table_index'
 and (z.f#>>'{locator,row}')::int>(p_configuration->>'header_row')::int
 and not coalesce((p_configuration->'repeat_headers'='true'::jsonb and jsonb_path_query_array(q.r,'$.raw_cells[*].value')=(
 select jsonb_path_query_array(hr,'$.raw_cells[*].value') from jsonb_array_elements(e.payload->'records') hr
 join lateral (select he from jsonb_array_elements(e.payload->'evidence') he where he->>'record_id'=hr->>'record_id' limit 1) hz on true
 where coalesce(hr#>>'{semantic_candidates,layout_grid_table}',hz.he#>>'{locator,table}')=p_configuration->>'table_index' and hz.he#>>'{locator,row}'=p_configuration->>'header_row'
 order by (hz.he#>>'{locator,page}')::int limit 1)),false)
 and not coalesce(p_configuration->'ocr_verified_rows','[]'::jsonb) ? (w->>'field')) then
 raise exception 'Verify each selected OCR product row against its source before confirmation' using errcode='23514'; end if;
 if p_confirmed and exists(select 1 from jsonb_array_elements(e.payload->'records') r
 where r#>>'{semantic_candidates,price_role}'='retail_guidance') then
 raise exception 'Retail guidance cannot be confirmed for wholesale cost comparison or export' using errcode='23514'; end if;
 for entry in select * from jsonb_each(p_corrections) loop
  if not exists(select 1 from jsonb_array_elements(e.payload->'records') r where r->>'record_id'=entry.key) or jsonb_typeof(entry.value)<>'object' or
   (entry.value-array['supplier_sku','description','cost_price','currency','pack_quantity','unit','retail_price_ex_vat','retail_price_inc_vat'])<>'{}'::jsonb then raise exception 'Correction outside extracted fields' using errcode='23514'; end if;
  for field in select * from jsonb_each(entry.value) loop
   if jsonb_typeof(field.value) not in ('string','null') or length(field.value::text)>10000 then raise exception 'Invalid correction value' using errcode='23514'; end if;
   if field.key='supplier_sku' and (jsonb_typeof(field.value)<>'string' or length(trim(field.value#>>'{}')) not between 1 and 500) then raise exception 'Identifier correction cannot be blank' using errcode='23514'; end if;
   if field.key in ('cost_price','pack_quantity','retail_price_ex_vat','retail_price_inc_vat') and jsonb_typeof(field.value)='string' and ((field.value#>>'{}') !~ '^[0-9]+([.,][0-9]+)?$' or length(field.value#>>'{}')>128 or (field.key='pack_quantity' and (field.value#>>'{}') ~ '^0+([.,]0+)?$')) then raise exception 'Correct prices/quantities using plain decimal text' using errcode='23514'; end if;
   if field.key='currency' and jsonb_typeof(field.value)='string' and (field.value#>>'{}') !~ '^[A-Z]{3}$' then raise exception 'Use a three-letter currency' using errcode='23514'; end if;
  end loop;
 end loop;
 insert into public.correction_revisions(tenant_id,extraction_run_id,source_file_id,revision,configuration,corrections,confirmed)
 values(p_tenant,e.id,e.source_file_id,n+1,p_configuration,p_corrections,p_confirmed) returning * into v;
 return to_jsonb(v);
end $$;

