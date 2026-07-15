-- Keep every production enrichment reversible and measurable.

create table if not exists public.data_enrichment_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  status text not null default 'staged'
    check (status in ('staged', 'applying', 'completed', 'rolled_back', 'failed')),
  stats jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.data_enrichment_backups (
  run_id uuid not null references public.data_enrichment_runs(id) on delete cascade,
  entity_table text not null,
  entity_id uuid not null,
  before_data jsonb not null,
  proposed_data jsonb not null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  primary key (run_id, entity_table, entity_id)
);

alter table public.data_enrichment_runs enable row level security;
alter table public.data_enrichment_backups enable row level security;

revoke all on table public.data_enrichment_runs from anon, authenticated;
revoke all on table public.data_enrichment_backups from anon, authenticated;

grant all on table public.data_enrichment_runs to service_role;
grant all on table public.data_enrichment_backups to service_role;

comment on table public.data_enrichment_runs is
  'Audit header for reversible production data-enrichment runs.';
comment on table public.data_enrichment_backups is
  'Before/proposed snapshots for every row changed by an enrichment run.';
