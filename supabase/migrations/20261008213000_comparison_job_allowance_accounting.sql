begin;

-- Inspection/extraction are preparation, not comparisons. Keep the existing
-- locked trial/paid accounting and upload reservations unchanged.
drop trigger bound_workspace_comparison on public.jobs;
create trigger bound_workspace_comparison after insert on public.jobs
  for each row when (new.kind = 'reconcile_csv')
  execute function private.consume_workspace_allowance();

commit;
