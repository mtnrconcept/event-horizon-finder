-- A summary and full request can overlap (for example a map hover while the
-- detail modal opens). Keep the richer cache row when the summary request
-- finishes last so later sessions never lose translated detail fields.
create or replace function public.preserve_full_event_translation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.translation_scope = 'full'
     and old.translation_status in ('machine', 'reviewed')
     and new.translation_scope = 'summary' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.preserve_full_event_translation()
  from public, anon, authenticated;

drop trigger if exists trg_event_translations_preserve_full
  on public.event_translations;
create trigger trg_event_translations_preserve_full
  before update on public.event_translations
  for each row execute function public.preserve_full_event_translation();
