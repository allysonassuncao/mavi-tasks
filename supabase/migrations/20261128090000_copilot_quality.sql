begin;

-- Assistente MAVI · alertas que ajudam de verdade.
--
-- O time recusava alertas óbvios, que não se aplicavam ou que repetiam o
-- que a tarefa já dizia — e a mesma recusa voltava na tarefa seguinte,
-- porque um aprendizado só entra em uso com 2 pessoas ou um líder. Agora:
--
-- 1. copilot_review_memory: os 👎 recentes do mesmo cliente (com motivo e
--    comentário) e do mesmo produto (só o alerta e o motivo: o comentário
--    pode falar de outro cliente) vão direto para a análise, que não os
--    repete, e o servidor barra alerta quase igual a um recusado. Os 👍
--    mostram o que o time valoriza.
-- 2. copilot_runs: o que a MAVI recebeu e respondeu em cada análise (o
--    rascunho, as fontes com a semelhança, a resposta crua e o veredito),
--    para conferir depois por que um alerta apareceu. Só o banco lê; fica
--    14 dias.

create index copilot_feedback_client_votes on public.copilot_feedback (company_id, client_id, updated_at desc);
create index copilot_feedback_product_votes on public.copilot_feedback (company_id, product_id, updated_at desc);

create function public.copilot_review_memory(p_company uuid, p_contract uuid, p_task uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid; v_product uuid; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 if p_task is not null then
  if not mavi_private.task_access(p_company, p_task) then
   raise exception 'Sem acesso a esta tarefa.' using errcode = '42501';
  end if;
  select t.contract_id into p_contract from public.tasks t where t.company_id = p_company and t.id = p_task;
 end if;
 select ct.client_id, ct.product_id into v_client, v_product
 from public.contracts ct where ct.company_id = p_company and ct.id = p_contract;
 if v_client is null then raise exception 'Produto não encontrado.' using errcode = 'P0002'; end if;
 if p_task is null and not mavi_private.dossier_reader(p_company, v_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'rejected', coalesce((
   select jsonb_agg(jsonb_build_object('kind', r.kind, 'title', r.alert_title, 'text', left(r.alert_text, 280),
     'reason', r.reason, 'comment', case when r.mine then nullif(left(r.comment, 300), '') end,
     'scope', case when r.mine then 'client' else 'product' end) order by r.updated_at desc)
   from (
    select * from (
     select distinct on (x.kind, lower(x.alert_title)) x.kind, x.alert_title, x.alert_text, x.reason, x.comment,
      x.client_id = v_client as mine, x.updated_at
     from public.copilot_feedback x
     where x.company_id = p_company and x.vote = 'down' and x.updated_at > now() - interval '120 days'
      and (x.client_id = v_client or x.product_id = v_product)
     order by x.kind, lower(x.alert_title), (x.client_id = v_client) desc, x.updated_at desc
    ) d order by d.mine desc, d.updated_at desc limit 15
   ) r), '[]'),
  'helped', coalesce((
   select jsonb_agg(jsonb_build_object('kind', h.kind, 'title', h.alert_title) order by h.updated_at desc)
   from (
    select * from (
     select distinct on (x.kind, lower(x.alert_title)) x.kind, x.alert_title, x.updated_at
     from public.copilot_feedback x
     where x.company_id = p_company and x.vote = 'up' and x.updated_at > now() - interval '120 days'
      and (x.client_id = v_client or x.product_id = v_product)
     order by x.kind, lower(x.alert_title), x.updated_at desc
    ) d order by d.updated_at desc limit 6
   ) h), '[]'));
end $$;

create table public.copilot_runs (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id),
 user_id uuid default auth.uid(),
 client_id uuid,
 task_id uuid,
 model text not null default '',
 -- O rascunho como a MAVI leu (título, campos, anexos, descrição).
 draft text not null default '',
 -- As referências [S#]/[D#] que ela recebeu: tipo, título, data, semelhança.
 sources jsonb not null default '[]',
 -- A resposta crua (com a revisão interna, que não aparece na tela).
 output text not null default '',
 alerts jsonb not null default '[]',
 verdict text,
 created_at timestamptz not null default now()
);
create index copilot_runs_company on public.copilot_runs (company_id, created_at desc);
alter table public.copilot_runs enable row level security;
revoke all on public.copilot_runs from public, anon, authenticated;

create function public.copilot_log_run(p_company uuid, p_client uuid, p_task uuid, p_model text, p_draft text,
 p_sources jsonb, p_output text, p_alerts jsonb, p_verdict text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 insert into public.copilot_runs (company_id, client_id, task_id, model, draft, sources, output, alerts, verdict)
 values (p_company, p_client, p_task, left(coalesce(p_model, ''), 120), left(coalesce(p_draft, ''), 8000),
  case when jsonb_typeof(p_sources) = 'array' and pg_column_size(p_sources) < 40000 then p_sources else '[]' end,
  left(coalesce(p_output, ''), 12000),
  case when jsonb_typeof(p_alerts) = 'array' and pg_column_size(p_alerts) < 40000 then p_alerts else '[]' end,
  left(p_verdict, 20));
 -- 14 dias bastam para conferir um alerta (a tabela não cresce sem fim).
 delete from public.copilot_runs r where r.company_id = p_company and r.created_at < now() - interval '14 days';
end $$;

revoke all on function public.copilot_review_memory(uuid, uuid, uuid),
 public.copilot_log_run(uuid, uuid, uuid, text, text, jsonb, text, jsonb, text) from public, anon;
grant execute on function public.copilot_review_memory(uuid, uuid, uuid),
 public.copilot_log_run(uuid, uuid, uuid, text, text, jsonb, text, jsonb, text) to authenticated;

commit;
