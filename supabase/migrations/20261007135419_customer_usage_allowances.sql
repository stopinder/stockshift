begin;
alter table public.workspace_subscriptions add column period_start timestamptz not null default now();
create table public.workspace_allowances(tenant_id uuid primary key references public.tenants(id),pilot_exempt boolean not null default false,trial_remaining integer not null default 3 check(trial_remaining between 0 and 3),reserved_files integer not null default 0 check(reserved_files>=0),reserved_bytes bigint not null default 0 check(reserved_bytes >= 0),paid_period_start timestamptz,paid_used integer not null default 0 check(paid_used >= 0));
alter table public.workspace_allowances enable row level security;
revoke all on public.workspace_allowances from public,anon,authenticated;
grant select on public.workspace_allowances to authenticated,service_role;
create policy member_read on public.workspace_allowances for select to authenticated using(private.has_role(tenant_id,array['owner','editor','viewer']));
-- Preserve already-authorized pilot workspaces; all later workspaces receive bounded trial access.
insert into public.workspace_allowances(tenant_id,pilot_exempt) select id,true from public.tenants;
create function private.initialize_workspace_allowance() returns trigger language plpgsql security definer set search_path='' as $$begin insert into public.workspace_allowances(tenant_id) values(new.id);return new;end;$$;
revoke all on function private.initialize_workspace_allowance() from public,anon,authenticated,service_role;
create trigger initialize_workspace_allowance after insert on public.tenants for each row execute function private.initialize_workspace_allowance();
create function private.consume_workspace_allowance() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.workspace_allowances; s public.workspace_subscriptions; paid boolean;
begin
 select * into a from public.workspace_allowances where tenant_id=new.tenant_id for update;
 if not found then raise exception 'Workspace allowance unavailable' using errcode='P0001';end if;
 if a.pilot_exempt then return new;end if;
 select * into s from public.workspace_subscriptions where tenant_id=new.tenant_id;
 paid := found and s.livemode and s.status='active' and s.period_start<=now() and s.period_end>now();
 if tg_table_name='source_files' then
   if a.reserved_files >= (case when paid then 200 else 20 end) or a.reserved_bytes + new.expected_byte_count > (case when paid then 524288000 else 104857600 end) then raise exception 'Workspace upload allowance reached' using errcode='P0001';end if;
   update public.workspace_allowances set reserved_files=reserved_files+1,reserved_bytes=reserved_bytes+new.expected_byte_count where tenant_id=new.tenant_id;
 else
   if paid then
     if a.paid_period_start is distinct from s.period_start then a.paid_used := 0;end if;
     if a.paid_used>=20 then raise exception 'Monthly comparison allowance reached' using errcode='P0001';end if;
     update public.workspace_allowances set paid_period_start=s.period_start,paid_used=a.paid_used+1 where tenant_id=new.tenant_id;
   else
     if a.trial_remaining=0 then raise exception 'Trial comparison allowance reached' using errcode='P0001';end if;
     update public.workspace_allowances set trial_remaining=trial_remaining-1 where tenant_id=new.tenant_id;
   end if;
 end if;
 return new;
end;$$;
revoke all on function private.consume_workspace_allowance() from public,anon,authenticated,service_role;
-- AFTER INSERT counts only accepted resources; transaction rollback restores the allowance.
-- Worker retries UPDATE existing jobs and idempotent enqueue returns the existing job.
create trigger bound_workspace_upload after insert on public.source_files for each row execute function private.consume_workspace_allowance();
create trigger bound_workspace_comparison after insert on public.jobs for each row execute function private.consume_workspace_allowance();
create function private.record_stockshift_subscription_v2(p_event text,p_tenant uuid,p_customer text,p_subscription text,p_status text,p_period_start timestamptz,p_period_end timestamptz,p_live boolean) returns void language plpgsql security invoker set search_path='' as $$
begin
 if p_period_start>=p_period_end then raise exception 'Invalid billing period' using errcode='22023';end if;
 if not exists(select 1 from public.billing_accounts where tenant_id=p_tenant and stripe_customer_id=p_customer) then raise exception 'Unknown billing account' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant::text,1));
 if exists(select 1 from private.billing_events where event_id=p_event) then return;end if;
 insert into public.workspace_subscriptions(tenant_id,stripe_subscription_id,status,period_start,period_end,livemode) values(p_tenant,p_subscription,p_status,p_period_start,p_period_end,p_live) on conflict(tenant_id) do update set stripe_subscription_id=excluded.stripe_subscription_id,status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,livemode=excluded.livemode,updated_at=now();
 insert into private.billing_events(event_id,tenant_id) values(p_event,p_tenant);
end;$$;
create function public.record_stockshift_subscription_v2(p_event text,p_tenant uuid,p_customer text,p_subscription text,p_status text,p_period_start timestamptz,p_period_end timestamptz,p_live boolean) returns void language sql security invoker set search_path='' as $$ select private.record_stockshift_subscription_v2(p_event,p_tenant,p_customer,p_subscription,p_status,p_period_start,p_period_end,p_live);$$;
revoke all on function public.record_stockshift_subscription_v2(text,uuid,text,text,text,timestamptz,timestamptz,boolean),private.record_stockshift_subscription_v2(text,uuid,text,text,text,timestamptz,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.record_stockshift_subscription_v2(text,uuid,text,text,text,timestamptz,timestamptz,boolean),private.record_stockshift_subscription_v2(text,uuid,text,text,text,timestamptz,timestamptz,boolean) to service_role;
commit;
