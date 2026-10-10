-- Change only cron failure classification, preserving other health-function fixes.
do $migration$
declare
  definition text;
begin
  definition := pg_get_functiondef(
    'public.check_indexer_health(interval,interval,boolean,bigint)'::regprocedure
  );
  if position('d.status <> ''succeeded''' in definition) > 0 then
    execute replace(definition, 'd.status <> ''succeeded''', 'd.status = ''failed''');
  elsif position('d.status = ''failed''' in definition) = 0 then
    raise exception 'Unexpected check_indexer_health definition; inspect cron status filtering';
  end if;
end;
$migration$;
