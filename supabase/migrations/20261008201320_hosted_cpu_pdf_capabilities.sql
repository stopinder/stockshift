-- Short-lived advertisements from the existing worker; no hosted defaults enabled.
create table private.cpu_pdf_workers (
  worker_id uuid primary key,
  inspection boolean not null,
  extraction boolean not null check (not extraction or inspection),
  expires_at timestamptz not null
);
alter table private.cpu_pdf_workers enable row level security;
revoke all on private.cpu_pdf_workers from public,anon,authenticated,service_role;
create function private.register_cpu_pdf_worker(p_worker uuid,p_inspection boolean,p_extraction boolean)
returns void language sql security definer set search_path='' as $$
  delete from private.cpu_pdf_workers where expires_at<=clock_timestamp();
  insert into private.cpu_pdf_workers values(p_worker,p_inspection,p_extraction,clock_timestamp()+interval '120 seconds')
  on conflict(worker_id) do update set inspection=excluded.inspection,extraction=excluded.extraction,expires_at=excluded.expires_at;
$$;
create function private.cpu_pdf_workers_agree(p_inspection boolean,p_extraction boolean)
returns boolean language sql security definer set search_path='' as $$
  select p_inspection and (not p_extraction or p_inspection) and count(*)>0
    and bool_and(inspection=p_inspection and extraction=p_extraction)
  from private.cpu_pdf_workers where expires_at>clock_timestamp();
$$;
create function public.register_cpu_pdf_worker(p_worker uuid,p_inspection boolean,p_extraction boolean)
returns void language sql security invoker set search_path='' as $$
  select private.register_cpu_pdf_worker(p_worker,p_inspection,p_extraction);
$$;
create function public.cpu_pdf_workers_agree(p_inspection boolean,p_extraction boolean)
returns boolean language sql security invoker set search_path='' as $$
  select private.cpu_pdf_workers_agree(p_inspection,p_extraction);
$$;
revoke all on function private.register_cpu_pdf_worker(uuid,boolean,boolean) from public,anon,authenticated;
revoke all on function private.cpu_pdf_workers_agree(boolean,boolean) from public,anon,authenticated;
grant execute on function private.register_cpu_pdf_worker(uuid,boolean,boolean) to service_role;
grant execute on function private.cpu_pdf_workers_agree(boolean,boolean) to service_role;
revoke all on function public.register_cpu_pdf_worker(uuid,boolean,boolean) from public,anon,authenticated;
revoke all on function public.cpu_pdf_workers_agree(boolean,boolean) from public,anon,authenticated;
grant execute on function public.register_cpu_pdf_worker(uuid,boolean,boolean) to service_role;
grant execute on function public.cpu_pdf_workers_agree(boolean,boolean) to service_role;
