begin;

-- Planejamento › Social Leads e Social Media: ao liberar a produção, quem
-- libera escolhe o prazo de entrega das tarefas de arte — uma data para
-- todas ou uma por post. Vai no mesmo p_assign de antes:
--
--   { "3": { "team": "...", "due": "2026-10-20" }, "due": "2026-10-18", "reason": "..." }
--
-- * "due" do post vale para ele; o "due" de fora vale para os posts sem data;
--   sem nenhum, hoje + os dias da arte da configuração (como era).
-- * Nunca antes de hoje. Antes do mínimo da regra de prazo, pede o motivo
--   ("reason" do post ou o de fora), como em toda tarefa; o erro diz o post.
-- * A data escolhida é "à mão" (a regra não recalcula depois da distribuição).
--
-- A da migração 20270130090000, com o prazo e o motivo.
create or replace function public.social_leads_release(p_plan uuid, p_assign jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; s public.social_leads_settings; fallback uuid; client uuid; name text;
 x public.social_leads_posts; a jsonb; team uuid; who uuid; t uuid; n integer := 0; due date; cyc boolean;
 cycle jsonb; today date; standard date; picked text; reason text; begin
 select * into p from public.social_leads_plans where id = p_plan;
 if not found or not mavi_private.social_leads_can_write(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if p_assign is not null and jsonb_typeof(p_assign) <> 'object' then
  raise exception 'Escolha de responsáveis inválida.' using errcode = '22023';
 end if;
 cycle := coalesce(p_assign->'cycle', '{}');
 if jsonb_typeof(cycle) <> 'object'
  or coalesce(jsonb_typeof(cycle->'followup'), 'string') <> 'string'
  or coalesce(jsonb_typeof(cycle->'meeting'), 'string') <> 'string'
  or coalesce(cycle->>'followup', '00000000-0000-0000-0000-000000000000') !~* '^[0-9a-f-]{36}$'
  or coalesce(cycle->>'meeting', '00000000-0000-0000-0000-000000000000') !~* '^[0-9a-f-]{36}$' then
  raise exception 'Responsável do ciclo inválido.' using errcode = '22023';
 end if;
 select s2.* into s from public.contracts k2
 join public.social_leads_settings s2 on s2.company_id = k2.company_id and s2.product_id = k2.product_id
 where k2.company_id = p.company_id and k2.id = p.contract_id;
 fallback := coalesce(s.design_team_id, s.team_id);
 if not exists (select 1 from public.social_leads_posts where plan_id = p.id and decision = 'approved' and task_id is null) then
  raise exception 'Nenhum post aprovado sem tarefa.' using errcode = '22023';
 end if;
 select k.client_id, coalesce(nullif(b.fields->>'clientName', ''), c.name) into client, name
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 left join public.social_leads_briefings b on b.company_id = k.company_id and b.contract_id = k.id
 where k.company_id = p.company_id and k.id = p.contract_id;
 today := mavi_private.company_today(p.company_id);
 standard := today + coalesce(s.art_days, 5);
 for x in select * from public.social_leads_posts where plan_id = p.id and decision = 'approved' and task_id is null
  order by number for update loop
  a := coalesce(p_assign, '{}')->(x.number::text);
  team := null;
  who := null;
  if a is not null and jsonb_typeof(a->'user') = 'string' then
   who := (a->>'user')::uuid;
   if not exists (select 1 from public.memberships where company_id = p.company_id and user_id = who and active) then
    raise exception 'Post %: responsável inválido.', x.number using errcode = '22023';
   end if;
  elsif a is not null and jsonb_typeof(a->'team') = 'string' then
   team := (a->>'team')::uuid;
   if not exists (select 1 from public.teams where company_id = p.company_id and id = team) then
    raise exception 'Post %: equipe não encontrada.', x.number using errcode = '22023';
   end if;
  else
   team := fallback;
   if team is null then
    raise exception 'Post %: escolha uma equipe ou um responsável (ou a equipe de criação em Configurar).', x.number
     using errcode = '22023';
   end if;
  end if;
  picked := coalesce(nullif(btrim(a->>'due'), ''), nullif(btrim(p_assign->>'due'), ''));
  if picked is null then
   due := standard;
  else
   due := null;
   if picked ~ '^\d{4}-\d{2}-\d{2}$' then
    begin
     due := picked::date;
    exception when others then
     due := null;
    end;
   end if;
   if due is null then
    raise exception 'Post %: prazo de entrega inválido.', x.number using errcode = '22023';
   end if;
   if due < today then
    raise exception 'Post %: o prazo de entrega não pode ser antes de hoje.', x.number using errcode = '22023';
   end if;
  end if;
  reason := coalesce(nullif(btrim(a->>'reason'), ''), nullif(btrim(p_assign->>'reason'), ''));
  if team is not null then
   insert into public.client_teams(company_id, client_id, team_id) values (p.company_id, client, team) on conflict do nothing;
  end if;
  begin
   t := public.create_task(p.company_id, p.contract_id,
    left(format('Arte do post %s%s · %s · %s', x.number, ' · ' || nullif(btrim(x.format), ''), p.label, name), 240), who, due, null, team,
    mavi_private.social_leads_task_text(x, p.label), 'normal',
    0, false, null, null, '{}', null, p_due_manual => true, p_due_reason => reason);
  exception when sqlstate 'MV002' then
   raise exception 'Post %: %', x.number, sqlerrm using errcode = 'MV002';
  end;
  update public.social_leads_posts set task_id = t where plan_id = p.id and number = x.number;
  n := n + 1;
 end loop;
 cyc := mavi_private.social_leads_start_cycle(p.company_id, p.contract_id,
  (cycle->>'followup')::uuid, (cycle->>'meeting')::uuid);
 return jsonb_build_object('created', n, 'cycle', cyc);
end $$;
revoke all on function public.social_leads_release(uuid, jsonb) from public, anon;
grant execute on function public.social_leads_release(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
