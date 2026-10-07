begin;
create function private.create_customer_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_tenant uuid;
begin
  if v_user is null or not exists (select 1 from auth.users where id=v_user and email_confirmed_at is not null and not coalesce(is_anonymous,false)) then
    raise exception 'Confirmed account required' using errcode='42501';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 200 then
    raise exception 'Workspace name required' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select tenant_id into v_tenant from public.tenant_memberships where user_id=v_user order by created_at,id limit 1;
  if v_tenant is not null then return v_tenant; end if;
  insert into public.tenants(name) values(btrim(p_name)) returning id into v_tenant;
  insert into public.tenant_memberships(tenant_id,user_id,role) values(v_tenant,v_user,'owner');
  return v_tenant;
end;
$$;
revoke all on function private.create_customer_workspace(text) from public,anon,service_role;
grant execute on function private.create_customer_workspace(text) to authenticated;
create function public.create_customer_workspace(p_name text) returns uuid
language sql security invoker set search_path='' as $$ select private.create_customer_workspace(p_name); $$;
revoke all on function public.create_customer_workspace(text) from public,anon,service_role;
grant execute on function public.create_customer_workspace(text) to authenticated;
commit;
