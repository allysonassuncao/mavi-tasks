begin;

-- Social Leads: quem recebe as tarefas do ciclo do cliente ("Acompanhamento
-- quinzenal" e "Reunião de resultados e novo plano") é escolhido no "Liberar
-- produção", em p_assign.cycle = {"followup": uuid, "meeting": uuid}. Sem
-- escolha, ficam com quem liberou (antes: o responsável do briefing). A
-- assinatura de social_leads_release não muda (o PostgREST continua achando).

drop function if exists mavi_private.social_leads_start_cycle(uuid, uuid);

create or replace function mavi_private.social_leads_start_cycle(p_company uuid, p_contract uuid,
 p_followup uuid default null, p_meeting uuid default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare b public.social_leads_briefings; client text; today date; f uuid; m uuid; begin
 select * into b from public.social_leads_briefings where company_id = p_company and contract_id = p_contract for update;
 if not found or b.cycle ? 'followup' then return false; end if;
 if exists (select 1 from unnest(array[p_followup, p_meeting]) as u where u is not null and not exists (
  select 1 from public.memberships where company_id = p_company and user_id = u and active)) then
  raise exception 'Responsável do ciclo inválido.' using errcode = '22023';
 end if;
 select coalesce(nullif(b.fields->>'clientName', ''), c.name) into client
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 where k.company_id = p_company and k.id = p_contract;
 today := mavi_private.company_today(p_company);
 f := public.create_task(p_company, p_contract, left('Acompanhamento quinzenal · ' || client, 240),
  coalesce(p_followup, auth.uid()), today + 14,
  null, null, 'Revise os resultados das últimas duas semanas (alcance, seguidores, leads) e alinhe com o cliente o que ajustar.',
  'normal', 30, false, null, null, '{}', 'biweekly');
 m := public.create_task(p_company, p_contract, left('Reunião de resultados e novo plano · ' || client, 240),
  coalesce(p_meeting, auth.uid()), today + 28,
  null, null, 'Apresente os resultados do mês ao cliente e gere o plano do próximo mês em Onboarding › Social Leads.',
  'high', 60, false, null, null, '{}', 'monthly');
 update public.social_leads_briefings set cycle = jsonb_build_object('followup', f, 'meeting', m, 'started_at', now())
 where company_id = p_company and contract_id = p_contract;
 return true;
end $$;
revoke all on function mavi_private.social_leads_start_cycle(uuid, uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.social_leads_release(p_plan uuid, p_assign jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; s public.social_leads_settings; fallback uuid; client uuid; name text;
 x public.social_leads_posts; a jsonb; team uuid; who uuid; t uuid; n integer := 0; due date; cyc boolean;
 cycle jsonb; begin
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
 select * into s from public.social_leads_settings where company_id = p.company_id;
 fallback := coalesce(s.design_team_id, s.team_id);
 if not exists (select 1 from public.social_leads_posts where plan_id = p.id and decision = 'approved' and task_id is null) then
  raise exception 'Nenhum post aprovado sem tarefa.' using errcode = '22023';
 end if;
 select k.client_id, coalesce(nullif(b.fields->>'clientName', ''), c.name) into client, name
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 left join public.social_leads_briefings b on b.company_id = k.company_id and b.contract_id = k.id
 where k.company_id = p.company_id and k.id = p.contract_id;
 due := mavi_private.company_today(p.company_id) + coalesce(s.art_days, 5);
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
  if team is not null then
   insert into public.client_teams(company_id, client_id, team_id) values (p.company_id, client, team) on conflict do nothing;
  end if;
  t := public.create_task(p.company_id, p.contract_id,
   left(format('Arte do post %s · %s · %s', x.number, p.label, name), 240), who, due, null, team,
   mavi_private.social_leads_task_text(x, p.label), case when x.is_ad then 'high' else 'normal' end,
   0, false, null, null, '{}', null);
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
