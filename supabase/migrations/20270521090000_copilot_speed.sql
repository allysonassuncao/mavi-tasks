begin;
-- Assistente MAVI nas tarefas · mais rápido e mais barato.
--
-- 1) O esforço (quanto o modelo raciocina) da funcionalidade 'task_copilot'
--    passa a ser escolhido no Painel da MAVI › Quem usa qual modelo › Por
--    funcionalidade. Sem escolha, o servidor usa "low": a análise já escreve
--    a revisão dos candidatos antes dos alertas.
-- 2) O registro de cada análise (copilot_runs) guarda quanto tempo cada parte
--    levou (contexto, primeiro token, modelo, total) e o esforço usado, para
--    medir a velocidade com dados reais.

create or replace function public.ai_set_effort(p_company uuid, p_key text, p_effort text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_skill uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem o esforço da MAVI.' using errcode = '42501';
 end if;
 if p_key ~ '^skill:[0-9a-f-]{36}$' then
  v_skill := substr(p_key, 7)::uuid;
  if not exists (select 1 from public.ai_skills where company_id = p_company and id = v_skill) then
   raise exception 'Skill não encontrada.' using errcode = 'P0002';
  end if;
 elsif coalesce(p_key, '') not in ('assistant', 'mavi_page', 'meetings_history', 'whatsapp_history', 'canvas_writer',
  'web_search', 'task_copilot') then
  raise exception 'Esta funcionalidade não tem esforço para escolher.' using errcode = '22023';
 end if;
 if p_effort is null then
  delete from mavi_private.ai_efforts where company_id = p_company and key = p_key;
  return;
 end if;
 if p_effort not in ('low', 'medium', 'high', 'xhigh', 'max') then
  raise exception 'Esforço inválido.' using errcode = '22023';
 end if;
 insert into mavi_private.ai_efforts(company_id, key, effort) values (p_company, p_key, p_effort)
 on conflict (company_id, key) do update set effort = excluded.effort, updated_by = auth.uid(), updated_at = now();
end $$;

alter table public.copilot_runs add column if not exists timings jsonb;

drop function public.copilot_log_run(uuid, uuid, uuid, text, text, jsonb, text, jsonb, text);
create function public.copilot_log_run(p_company uuid, p_client uuid, p_task uuid, p_model text, p_draft text,
 p_sources jsonb, p_output text, p_alerts jsonb, p_verdict text, p_timings jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 insert into public.copilot_runs (company_id, client_id, task_id, model, draft, sources, output, alerts, verdict,
  timings)
 values (p_company, p_client, p_task, left(coalesce(p_model, ''), 120), left(coalesce(p_draft, ''), 8000),
  case when jsonb_typeof(p_sources) = 'array' and pg_column_size(p_sources) < 40000 then p_sources else '[]' end,
  left(coalesce(p_output, ''), 12000),
  case when jsonb_typeof(p_alerts) = 'array' and pg_column_size(p_alerts) < 40000 then p_alerts else '[]' end,
  left(p_verdict, 20),
  case when jsonb_typeof(p_timings) = 'object' and pg_column_size(p_timings) < 2000 then p_timings end);
 -- 14 dias bastam para conferir um alerta (a tabela não cresce sem fim).
 delete from public.copilot_runs r where r.company_id = p_company and r.created_at < now() - interval '14 days';
end $$;
revoke all on function public.copilot_log_run(uuid, uuid, uuid, text, text, jsonb, text, jsonb, text, jsonb)
 from public, anon;
grant execute on function public.copilot_log_run(uuid, uuid, uuid, text, text, jsonb, text, jsonb, text, jsonb)
 to authenticated;

commit;
