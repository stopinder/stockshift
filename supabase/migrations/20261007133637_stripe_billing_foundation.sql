begin;
create table public.billing_accounts(tenant_id uuid primary key references public.tenants(id),stripe_customer_id text not null unique check(stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),created_at timestamptz not null default now());
create table public.workspace_subscriptions(tenant_id uuid primary key references public.billing_accounts(tenant_id),stripe_subscription_id text not null unique,status text not null check(status in ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused')),period_end timestamptz not null,livemode boolean not null,updated_at timestamptz not null default now());
create table private.billing_events(event_id text primary key,tenant_id uuid not null references public.tenants(id),processed_at timestamptz not null default now());
alter table public.billing_accounts enable row level security;
alter table public.workspace_subscriptions enable row level security;
alter table private.billing_events enable row level security;
revoke all on public.billing_accounts,public.workspace_subscriptions,private.billing_events from public,anon,authenticated;
grant select on public.billing_accounts,public.workspace_subscriptions to authenticated;
grant select,insert,update on public.billing_accounts,public.workspace_subscriptions,private.billing_events to service_role;
create policy owner_read on public.billing_accounts for select to authenticated using(private.has_role(tenant_id,array['owner']));
create policy owner_read on public.workspace_subscriptions for select to authenticated using(private.has_role(tenant_id,array['owner']));
create function private.record_stockshift_subscription(p_event text,p_tenant uuid,p_customer text,p_subscription text,p_status text,p_period_end timestamptz,p_live boolean) returns void language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.billing_accounts where tenant_id=p_tenant and stripe_customer_id=p_customer) then raise exception 'Unknown billing account' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant::text,1));
 if exists(select 1 from private.billing_events where event_id=p_event) then return;end if;
 insert into public.workspace_subscriptions(tenant_id,stripe_subscription_id,status,period_end,livemode) values(p_tenant,p_subscription,p_status,p_period_end,p_live) on conflict(tenant_id) do update set stripe_subscription_id=excluded.stripe_subscription_id,status=excluded.status,period_end=excluded.period_end,livemode=excluded.livemode,updated_at=now();
 insert into private.billing_events(event_id,tenant_id) values(p_event,p_tenant);
end;$$;
create function public.record_stockshift_subscription(p_event text,p_tenant uuid,p_customer text,p_subscription text,p_status text,p_period_end timestamptz,p_live boolean) returns void language sql security invoker set search_path='' as $$select private.record_stockshift_subscription(p_event,p_tenant,p_customer,p_subscription,p_status,p_period_end,p_live);$$;
revoke all on function public.record_stockshift_subscription(text,uuid,text,text,text,timestamptz,boolean),private.record_stockshift_subscription(text,uuid,text,text,text,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.record_stockshift_subscription(text,uuid,text,text,text,timestamptz,boolean),private.record_stockshift_subscription(text,uuid,text,text,text,timestamptz,boolean) to service_role;
commit;
