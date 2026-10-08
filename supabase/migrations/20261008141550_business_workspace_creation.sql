begin;
alter table public.workspace_allowances add column subscription_required boolean not null default false;
alter table public.workspace_allowances add column test_workspace boolean not null default false;
create table private.workspace_trial_claims(user_id uuid primary key references auth.users(id),tenant_id uuid not null references public.tenants(id),created_at timestamptz not null default now());
create table private.workspace_creation_requests(user_id uuid not null references auth.users(id),request_id uuid not null,tenant_id uuid not null unique references public.tenants(id),primary key(user_id,request_id));
alter table private.workspace_trial_claims enable row level security;
alter table private.workspace_creation_requests enable row level security;
revoke all on private.workspace_trial_claims,private.workspace_creation_requests from public,anon,authenticated,service_role;
-- Existing owner accounts have already received workspace access; do not issue a second trial.
insert into private.workspace_trial_claims(user_id,tenant_id)
select distinct on(user_id) user_id,tenant_id from public.tenant_memberships where role='owner' order by user_id,created_at,id;
create function private.workspace_creation_status() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u uuid:=auth.uid();n integer;
begin
 if u is null or not exists(select 1 from auth.users where id=u and email_confirmed_at is not null and not coalesce(is_anonymous,false)) then raise exception 'Confirmed account required' using errcode='42501';end if;
 select count(*)::integer into n from public.tenant_memberships where user_id=u and role='owner';
 return jsonb_build_object('owned_count',n,'workspace_limit',3,'trial_available',not exists(select 1 from private.workspace_trial_claims where user_id=u) and not exists(select 1 from public.tenant_memberships m join public.workspace_allowances a on a.tenant_id=m.tenant_id where m.user_id=u and m.role='owner' and not a.test_workspace));
end;$$;
create function public.workspace_creation_status() returns jsonb language sql stable security invoker set search_path='' as $$select private.workspace_creation_status();$$;
create function private.create_business_workspace(p_name text,p_request uuid,p_test boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();t uuid;trial boolean;required boolean;test_only boolean;
begin
 if u is null or not exists(select 1 from auth.users where id=u and email_confirmed_at is not null and not coalesce(is_anonymous,false)) then raise exception 'Confirmed account required' using errcode='42501';end if;
 if p_name is null or length(btrim(p_name)) not between 1 and 200 or p_request is null or p_test is null then raise exception 'Workspace name and creation request required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select tenant_id into t from private.workspace_creation_requests where user_id=u and request_id=p_request;
 if t is null then
  if (select count(*) from public.tenant_memberships where user_id=u and role='owner')>=3 then raise exception 'Workspace limit reached (3). Contact support before adding another business.' using errcode='P0001';end if;
  trial:=not p_test and not exists(select 1 from private.workspace_trial_claims where user_id=u) and not exists(select 1 from public.tenant_memberships m join public.workspace_allowances a on a.tenant_id=m.tenant_id where m.user_id=u and m.role='owner' and not a.test_workspace);
  insert into public.tenants(name) values(btrim(p_name)) returning id into t;
  insert into public.tenant_memberships(tenant_id,user_id,role) values(t,u,'owner');
  update public.workspace_allowances set subscription_required=not trial,test_workspace=p_test,trial_remaining=case when trial then 3 else 0 end where tenant_id=t;
  if trial then insert into private.workspace_trial_claims(user_id,tenant_id) values(u,t);end if;
  insert into private.workspace_creation_requests(user_id,request_id,tenant_id) values(u,p_request,t);
 end if;
 select subscription_required,test_workspace into required,test_only from public.workspace_allowances where tenant_id=t;
 return jsonb_build_object('tenant_id',t,'subscription_required',required,'test_workspace',test_only);
end;$$;
create function public.create_business_workspace(p_name text,p_request uuid,p_test boolean default false) returns jsonb language sql security invoker set search_path='' as $$select private.create_business_workspace(p_name,p_request,p_test);$$;
-- Preserve legacy first-membership onboarding, but route new creation through the trial ledger.
create or replace function private.create_customer_workspace(p_name text) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();t uuid;
begin
 if u is null or not exists(select 1 from auth.users where id=u and email_confirmed_at is not null and not coalesce(is_anonymous,false)) then raise exception 'Confirmed account required' using errcode='42501';end if;
 if p_name is null or length(btrim(p_name)) not between 1 and 200 then raise exception 'Workspace name required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 select tenant_id into t from public.tenant_memberships where user_id=u order by created_at,id limit 1;
 if t is not null then return t;end if;
 return (private.create_business_workspace(p_name,u,false)->>'tenant_id')::uuid;
end;$$;
revoke all on function private.workspace_creation_status(),public.workspace_creation_status(),private.create_business_workspace(text,uuid,boolean),public.create_business_workspace(text,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function private.workspace_creation_status(),public.workspace_creation_status(),private.create_business_workspace(text,uuid,boolean),public.create_business_workspace(text,uuid,boolean) to authenticated;
create function private.require_workspace_subscription() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.workspace_allowances a where a.tenant_id=new.tenant_id and a.subscription_required and (a.test_workspace or not exists(select 1 from public.workspace_subscriptions s where s.tenant_id=a.tenant_id and s.livemode and s.status='active' and s.period_start<=now() and s.period_end>now()))) then
  raise exception 'This workspace requires its own active subscription before uploading or processing.' using errcode='P0001';
 end if;
 return new;
end;$$;
revoke all on function private.require_workspace_subscription() from public,anon,authenticated,service_role;
create trigger require_paid_workspace_upload before insert on public.source_files for each row execute function private.require_workspace_subscription();
create trigger require_paid_workspace_job before insert on public.jobs for each row execute function private.require_workspace_subscription();
-- Reuse the existing quota projection for ordinary workspaces and add an explicit locked state.
alter function private.workspace_allowance_status(uuid) rename to workspace_allowance_status_base;
create function private.workspace_allowance_status(p_tenant uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.workspace_allowances;paid boolean;
begin
 if auth.uid() is null or not private.has_role(p_tenant,array['owner','editor','viewer']) then raise exception 'Workspace access denied' using errcode='42501';end if;
 select * into a from public.workspace_allowances where tenant_id=p_tenant;
 paid:=exists(select 1 from public.workspace_subscriptions s where s.tenant_id=p_tenant and s.livemode and s.status='active' and s.period_start<=now() and s.period_end>now());
 if a.subscription_required and (a.test_workspace or not paid) then
  return jsonb_build_object('plan','subscription_required','comparisons_remaining',0,'comparison_limit',20,'uploads_remaining',0,'upload_limit',200,'bytes_remaining',0,'byte_limit',524288000,'period_end',null,'test_workspace',a.test_workspace);
 end if;
 return private.workspace_allowance_status_base(p_tenant);
end;$$;
revoke all on function private.workspace_allowance_status(uuid) from public,anon,authenticated,service_role;
grant execute on function private.workspace_allowance_status(uuid) to authenticated;
-- SQL wrappers can hold dependencies on the renamed function; replace explicitly.
create or replace function public.workspace_allowance_status(p_tenant uuid) returns jsonb language sql stable security invoker set search_path='' as $$select private.workspace_allowance_status(p_tenant);$$;
commit;
