begin;
-- Worker output stays immutable. Human decisions are append-only exclusions, not new matches.
create table public.review_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  comparison_run_id uuid not null,
  comparison_result_id uuid not null unique,
  actor_id uuid not null references auth.users(id),
  decision text not null check (decision in ('reject','no_match')),
  note text not null check (length(btrim(note)) between 1 and 1000),
  created_at timestamptz not null default now(),
  foreign key (tenant_id,comparison_run_id,comparison_result_id)
    references public.comparison_results(tenant_id,comparison_run_id,id)
);
create index review_events_tenant_run on public.review_events(tenant_id,comparison_run_id);
alter table public.review_events enable row level security;
revoke all on public.review_events from public,anon,authenticated,service_role;
grant select on public.review_events to authenticated,service_role;
create policy tenant_read on public.review_events for select to authenticated
  using (private.has_role(tenant_id,array['owner','editor','viewer']));

create function private.resolve_csv_review(p_tenant uuid,p_run uuid,p_result uuid,p_decision text,p_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.comparison_results; e public.review_events; state text;
begin
  if not private.has_role(p_tenant,array['owner','editor']) then
    raise exception 'Editor membership required' using errcode='42501'; end if;
  select status into state from public.comparison_runs where tenant_id=p_tenant and id=p_run for update;
  if not found then raise exception 'Run outside tenant' using errcode='42501'; end if;
  if state<>'succeeded' then raise exception 'Completed run required' using errcode='23514'; end if;
  select * into r from public.comparison_results
    where tenant_id=p_tenant and comparison_run_id=p_run and id=p_result;
  if not found then raise exception 'Result outside run' using errcode='42501'; end if;
  if r.review_state<>'pending' or p_decision is null or p_decision not in ('reject','no_match')
    or p_note is null or length(btrim(p_note)) not between 1 and 1000
    or (p_decision='no_match' and r.old_values is not null and r.new_values is not null) then
    raise exception 'Only explicit supported review exclusions are allowed' using errcode='23514'; end if;
  select * into e from public.review_events where comparison_result_id=p_result;
  if found then
    if e.decision is distinct from p_decision or e.note is distinct from btrim(p_note) then
      raise exception 'Review decision already recorded' using errcode='23514'; end if;
    return to_jsonb(e);
  end if;
  insert into public.review_events(tenant_id,comparison_run_id,comparison_result_id,actor_id,decision,note)
    values(p_tenant,p_run,p_result,auth.uid(),p_decision,btrim(p_note)) returning * into e;
  return to_jsonb(e);
end $$;
create function public.resolve_csv_review(p_tenant uuid,p_run uuid,p_result uuid,p_decision text,p_note text)
returns jsonb language sql security invoker set search_path='' as $$
  select private.resolve_csv_review(p_tenant,p_run,p_result,p_decision,p_note);
$$;

-- Counts are computed in PostgreSQL from persisted output, never inferred from a browser page.
create function public.csv_run_summary(p_tenant uuid,p_run uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('total',r.result_count,'outcomes',
    coalesce((select jsonb_object_agg(primary_outcome,n) from
      (select primary_outcome,count(*) as n from public.comparison_results
       where tenant_id=p_tenant and comparison_run_id=p_run group by primary_outcome) c),'{}'::jsonb),
    'unresolved',(select count(*) from public.comparison_results cr
      where cr.tenant_id=p_tenant and cr.comparison_run_id=p_run and cr.review_state='pending'
      and not exists(select 1 from public.review_events e where e.comparison_result_id=cr.id)),
    'excluded',(select count(*) from public.review_events where tenant_id=p_tenant and comparison_run_id=p_run))
  from public.comparison_runs r where r.tenant_id=p_tenant and r.id=p_run;
$$;
-- Paginated search reads immutable rows plus audited decisions. Numeric JSON fields are deliberately omitted.
create function public.csv_results_page(p_tenant uuid,p_run uuid,p_outcome text default '',
  p_search text default '',p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(v order by sku,id),'[]'::jsonb) from (
    select cr.id,coalesce(cr.new_values->>'supplier_sku',cr.old_values->>'supplier_sku','') as sku,
      jsonb_build_object('id',cr.id,'primary_outcome',cr.primary_outcome,'review_state',cr.review_state,
      'change_flags',cr.change_flags,'old_values',cr.old_values,'new_values',cr.new_values,
      'cost_delta_text',cr.cost_delta_text,'cost_change_percent_text',cr.cost_change_percent_text,
      'percentage_state',cr.percentage_state,'reasons',cr.reasons,'provenance',cr.provenance,
      'decision',e.decision,'note',e.note,'reviewed_at',e.created_at) as v
    from public.comparison_results cr left join public.review_events e on e.comparison_result_id=cr.id
    where cr.tenant_id=p_tenant and cr.comparison_run_id=p_run
      and (p_outcome='' or cr.primary_outcome=p_outcome)
      and (p_search='' or position(lower(left(p_search,200)) in lower(coalesce(cr.old_values->>'supplier_sku','')||' '||
        coalesce(cr.new_values->>'supplier_sku','')||' '||coalesce(cr.old_values->>'description','')||' '||
        coalesce(cr.new_values->>'description',''))) > 0)
    order by sku,cr.id limit 101 offset greatest(0,least(p_offset,20000))
  ) page;
$$;

create function private.csv_export_rows(p_tenant uuid,p_run uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare state text; output jsonb;
begin
  if not private.has_role(p_tenant,array['owner','editor','viewer']) then
    raise exception 'Tenant membership required' using errcode='42501'; end if;
  select status into state from public.comparison_runs where tenant_id=p_tenant and id=p_run for share;
  if not found then raise exception 'Run outside tenant' using errcode='42501'; end if;
  if state<>'succeeded' then raise exception 'Completed run required' using errcode='23514'; end if;
  if exists(select 1 from public.comparison_results r where r.tenant_id=p_tenant
    and r.comparison_run_id=p_run and r.review_state='pending'
    and not exists(select 1 from public.review_events e where e.comparison_result_id=r.id)) then
    raise exception 'Resolve all review items before export' using errcode='23514'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'supplier_sku',new_values->>'supplier_sku','description',new_values->>'description',
    'currency',new_values->>'currency','unit',new_values->>'unit',
    'pack_quantity',new_values->>'pack_quantity','price_basis',new_values->>'price_basis',
    'tax_basis',new_values->>'tax_basis','old_cost',old_values->>'cost_price',
    'new_cost',new_values->>'cost_price','cost_delta',cost_delta_text,
    'cost_change_percent',cost_change_percent_text,'percentage_state',percentage_state,
    'change_flags',change_flags) order by new_values->>'supplier_sku',id),'[]'::jsonb)
    into output from public.comparison_results where tenant_id=p_tenant and comparison_run_id=p_run
      and primary_outcome='changed' and review_state='not_required';
  return output;
end $$;
create function public.csv_export_rows(p_tenant uuid,p_run uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select private.csv_export_rows(p_tenant,p_run);
$$;
revoke all on function private.resolve_csv_review(uuid,uuid,uuid,text,text) from public,anon,service_role;
revoke all on function public.resolve_csv_review(uuid,uuid,uuid,text,text) from public,anon,service_role;
revoke all on function private.csv_export_rows(uuid,uuid) from public,anon,service_role;
revoke all on function public.csv_export_rows(uuid,uuid) from public,anon,service_role;
revoke all on function public.csv_run_summary(uuid,uuid) from public,anon,service_role;
revoke all on function public.csv_results_page(uuid,uuid,text,text,integer) from public,anon,service_role;
grant execute on function private.resolve_csv_review(uuid,uuid,uuid,text,text) to authenticated;
grant execute on function public.resolve_csv_review(uuid,uuid,uuid,text,text) to authenticated;
grant execute on function private.csv_export_rows(uuid,uuid) to authenticated;
grant execute on function public.csv_export_rows(uuid,uuid) to authenticated;
grant execute on function public.csv_run_summary(uuid,uuid) to authenticated;
grant execute on function public.csv_results_page(uuid,uuid,text,text,integer) to authenticated;
commit;
