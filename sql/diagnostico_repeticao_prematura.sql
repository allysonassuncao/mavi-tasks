-- Diagnóstico: por que a série "Acompanhar consumo de provedores no Painel da
-- MAVI" tem tarefas com prazo 07/10 e 08/10 já em 06/10.
-- Só leitura. Uma consulta só (o pgAdmin mostra apenas o último resultado).

with r as (
 select r.* from public.task_recurrences r
 where r.id in (select t.recurrence_id from public.tasks t
  where t.title = 'Acompanhar consumo de provedores no Painel da MAVI' and t.recurrence_id is not null)
), tz as (
 select r.id, coalesce(c.timezone, 'America/Sao_Paulo') as zone from r join public.companies c on c.id = r.company_id
)
select * from (
 -- A regra da série
 select 1 as ord, null::timestamptz as quando, 'regra ' || r.id as item,
  'freq ' || r.frequency || ' | início ' || r.anchor || ' | próxima ' || r.next_run || ' | cópias ' || r.copies
  || ' | due_offset ' || r.due_offset || ' | start_offset ' || coalesce(r.start_offset::text, '-')
  || ' | pela regra ' || r.due_by_rule || ' | ativa ' || r.active
  || ' | criada ' || (r.created_at at time zone tz.zone) || ' | erro ' || coalesce(r.last_error, '-') as valor
 from r join tz on tz.id = r.id
 union all
 -- Cada tarefa da série
 select 2, t.created_at, 'tarefa ' || t.id || case when t.id = r.source_task_id then ' (original)' else '' end,
  'criada ' || (t.created_at at time zone tz.zone) || ' | prazo ' || t.due_date
  || ' | início ' || coalesce(t.start_date::text, '-') || ' | status ' || t.status
  || ' | arquivada ' || t.archived || ' | prazo à mão ' || t.due_manual
 from public.tasks t join r on r.id = t.recurrence_id join tz on tz.id = r.id
 union all
 -- O que o histórico registrou na criação
 select 3, e.created_at, 'evento ' || e.action || ' em ' || e.task_id,
  (e.created_at at time zone tz.zone) || ' | ' || coalesce(e.detail::text, '')
 from public.task_events e join public.tasks t on t.id = e.task_id join r on r.id = t.recurrence_id join tz on tz.id = r.id
 where e.action in ('created', 'recurrence_started')
 union all
 -- Agendamentos que rodam a repetição (deveria haver um só)
 select 4, null, 'cron ' || j.jobid || ' ' || j.jobname, j.schedule || ' | ' || j.command || ' | ativo ' || j.active
 from cron.job j where j.command ilike '%recurrence%'
 union all
 -- Últimas execuções desses agendamentos
 select 5, d.start_time, 'execução ' || d.jobid, d.status || ' | ' || coalesce(d.return_message, '')
 from (select d.* from cron.job_run_details d
  where d.jobid in (select jobid from cron.job where command ilike '%recurrence%')
  order by d.start_time desc limit 12) d
) x order by ord, quando;
