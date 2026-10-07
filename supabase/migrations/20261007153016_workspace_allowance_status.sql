begin;
-- Read-only, member-scoped projection. Subscription identifiers stay owner-only.
create function private.workspace_allowance_status(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a public.workspace_allowances;
  s public.workspace_subscriptions;
  paid boolean;
  remaining integer;
begin
  if auth.uid() is null or not private.has_role(p_tenant,array['owner','editor','viewer']) then
    raise exception 'Workspace access denied' using errcode='42501';
  end if;
  select * into a from public.workspace_allowances where tenant_id=p_tenant;
  if not found then raise exception 'Workspace allowance unavailable' using errcode='P0001'; end if;
  if a.pilot_exempt then
    return jsonb_build_object('plan','pilot','comparisons_remaining',null,'comparison_limit',null,
      'uploads_remaining',null,'upload_limit',null,'bytes_remaining',null,'byte_limit',null,'period_end',null);
  end if;
  select * into s from public.workspace_subscriptions where tenant_id=p_tenant;
  paid := found and s.livemode and s.status='active' and s.period_start<=now() and s.period_end>now();
  remaining := case when paid then greatest(0,20-case when a.paid_period_start is not distinct from s.period_start then a.paid_used else 0 end) else a.trial_remaining end;
  return jsonb_build_object('plan',case when paid then 'paid' else 'trial' end,
    'comparisons_remaining',remaining,'comparison_limit',case when paid then 20 else 3 end,
    'uploads_remaining',greatest(0,(case when paid then 200 else 20 end)-a.reserved_files),
    'upload_limit',case when paid then 200 else 20 end,
    'bytes_remaining',greatest(0,(case when paid then 524288000 else 104857600 end)-a.reserved_bytes),
    'byte_limit',case when paid then 524288000 else 104857600 end,
    'period_end',case when paid then s.period_end else null end);
end;
$$;
revoke all on function private.workspace_allowance_status(uuid) from public,anon,authenticated,service_role;
grant execute on function private.workspace_allowance_status(uuid) to authenticated;
create function public.workspace_allowance_status(p_tenant uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select private.workspace_allowance_status(p_tenant);
$$;
revoke all on function public.workspace_allowance_status(uuid) from public,anon,authenticated,service_role;
grant execute on function public.workspace_allowance_status(uuid) to authenticated;
commit;
