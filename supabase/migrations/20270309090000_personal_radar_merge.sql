begin;

-- MAVI · Radar pessoal: uma situação por demanda de fundo.
--
-- Num grupo, a MAVI criava um item por sub-assunto (ex.: "cobranças
-- contestadas", "WhatsApps sem funcionar" e "requerimento sem resposta") quando
-- a conversa toda era uma demanda só (o cancelamento, com esses motivos). Agora:
-- * a leitura junta o que pediria uma única resposta (regra no prompt, em
--   api/_personal-radar.ts);
-- * a consolidação: com duas ou mais situações abertas num grupo, a MAVI
--   revisa e junta as da mesma demanda (o worker, depois da leitura; também
--   corrige as que já existem);
-- * "Juntar com…": a pessoa junta à mão (e isso vira aprendizado).
-- Ao juntar, as falas, os donos e as cobranças somam no item que fica; a
-- resposta sugerida dele, se ainda não foi copiada, é escrita de novo com o
-- contexto inteiro.

alter table public.personal_radar_groups add column consolidated_at timestamptz;

alter table public.personal_radar_feedback drop constraint personal_radar_feedback_action_check;
alter table public.personal_radar_feedback add constraint personal_radar_feedback_action_check
 check (action in ('not_mine', 'not_situation', 'already_resolved', 'other', 'resolved',
  'reopened', 'approved', 'edited', 'rejected', 'training', 'merged'));

-- Junta p_sources em p_target (todos do mesmo grupo). Título, resumo e tipo
-- novos são opcionais. Devolve o item que ficou (nulo se nada mudou).
create function mavi_private.personal_radar_merge(p_target uuid, p_sources uuid[], p_title text default null,
 p_summary text default null, p_kind text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t public.personal_radar_items; v_sources uuid[]; begin
 select * into t from public.personal_radar_items where id = p_target for update;
 if not found then return null; end if;
 select coalesce(array_agg(i.id), '{}') into v_sources from public.personal_radar_items i
 where i.id = any(coalesce(p_sources, '{}')) and i.id <> t.id and i.group_id = t.group_id;
 if cardinality(v_sources) = 0 then return null; end if;
 -- As falas (sem repetir a mesma mensagem).
 insert into public.personal_radar_mentions(company_id, item_id, message_id, role, speaker, quote, at)
 select m.company_id, t.id, m.message_id, m.role, m.speaker, m.quote, m.at from public.personal_radar_mentions m
 where m.item_id = any(v_sources)
 on conflict (item_id, message_id) do nothing;
 -- Os donos: o motivo mais forte fica; descartado só se descartou em todos.
 insert into public.personal_radar_owners as o (company_id, item_id, user_id, reason, why, state, dismissed_reason,
  dismissed_note, dismissed_at)
 select distinct on (s.user_id) s.company_id, t.id, s.user_id, s.reason, s.why, s.state, s.dismissed_reason,
  s.dismissed_note, s.dismissed_at
 from public.personal_radar_owners s where s.item_id = any(v_sources)
 order by s.user_id, (s.state = 'open') desc,
  case s.reason when 'mention' then 0 when 'reply' then 1 when 'role' then 2 else 3 end
 on conflict (item_id, user_id) do update set
  state = case when o.state = 'open' or excluded.state = 'open' then 'open' else o.state end,
  dismissed_reason = case when o.state = 'open' or excluded.state = 'open' then null else o.dismissed_reason end,
  dismissed_note = case when o.state = 'open' or excluded.state = 'open' then null else o.dismissed_note end,
  dismissed_at = case when o.state = 'open' or excluded.state = 'open' then null else o.dismissed_at end,
  reason = case when (case excluded.reason when 'mention' then 0 when 'reply' then 1 when 'role' then 2 else 3 end)
   < (case o.reason when 'mention' then 0 when 'reply' then 1 when 'role' then 2 else 3 end) then excluded.reason else o.reason end,
  why = case when (case excluded.reason when 'mention' then 0 when 'reply' then 1 when 'role' then 2 else 3 end)
   < (case o.reason when 'mention' then 0 when 'reply' then 1 when 'role' then 2 else 3 end) then excluded.why else o.why end;
 update public.personal_radar_items i set
  title = coalesce(nullif(left(btrim(coalesce(p_title, '')), 200), ''), i.title),
  summary = coalesce(nullif(left(btrim(coalesce(p_summary, '')), 1500), ''), i.summary),
  kind = case when p_kind in ('question', 'request', 'complaint', 'material', 'approval', 'deadline') then p_kind else i.kind end,
  urgency = greatest(i.urgency, (select max(s.urgency) from public.personal_radar_items s where s.id = any(v_sources))),
  first_at = least(i.first_at, (select min(s.first_at) from public.personal_radar_items s where s.id = any(v_sources))),
  last_at = greatest(i.last_at, (select max(s.last_at) from public.personal_radar_items s where s.id = any(v_sources))),
  asks = greatest(1, (select count(*) from public.personal_radar_mentions m where m.item_id = i.id and m.role = 'client')),
  task_id = coalesce(i.task_id, (select s.task_id from public.personal_radar_items s where s.id = any(v_sources)
   and s.task_id is not null order by s.last_at desc limit 1)),
  radar_item_id = coalesce(i.radar_item_id, (select s.radar_item_id from public.personal_radar_items s where s.id = any(v_sources)
   and s.radar_item_id is not null order by s.last_at desc limit 1)),
  status = case when i.status = 'open' or exists (select 1 from public.personal_radar_items s where s.id = any(v_sources)
   and s.status = 'open') then 'open' else i.status end,
  resolved_at = case when i.status = 'open' or exists (select 1 from public.personal_radar_items s where s.id = any(v_sources)
   and s.status = 'open') then null else i.resolved_at end,
  updated_at = now()
 where i.id = t.id;
 -- A resposta ainda não copiada é escrita de novo com tudo junto.
 delete from public.personal_radar_replies r where r.item_id = t.id and r.approved_at is null;
 delete from public.personal_radar_items where id = any(v_sources);
 perform mavi_private.broadcast(t.company_id, jsonb_build_object('kind', 'personal_radar',
  'people', (select coalesce(jsonb_agg(o.user_id), '[]') from public.personal_radar_owners o where o.item_id = t.id)));
 return t.id;
end $$;
revoke all on function mavi_private.personal_radar_merge(uuid, uuid[], text, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------ worker
-- Grupos com duas ou mais situações abertas que mudaram desde a última
-- consolidação: [{group_id, company_id, client_name, group, items: [...]}].
create function public.ai_personal_radar_consolidate_claim(p_secret text, p_limit integer default 4) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_out jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 with due as (
  select q.group_id from public.personal_radar_groups q
  where (q.claimed_until is null or q.claimed_until < now())
   and (select count(*) from public.personal_radar_items i where i.group_id = q.group_id and i.status = 'open') >= 2
   and (q.consolidated_at is null or exists (select 1 from public.personal_radar_items i where i.group_id = q.group_id
    and i.status = 'open' and i.updated_at > q.consolidated_at))
  order by q.consolidated_at nulls first
  limit least(greatest(coalesce(p_limit, 4), 1), 10)
  for update of q skip locked
 ), claimed as (
  update public.personal_radar_groups q set claimed_until = now() + interval '5 minutes'
  from due where q.group_id = due.group_id
  returning q.group_id, q.company_id
 )
 select coalesce(jsonb_agg(jsonb_build_object('group_id', c.group_id, 'company_id', c.company_id,
   'client_name', (select k.name from public.whatsapp_groups g join public.clients k on k.id = g.client_id where g.id = c.group_id),
   'group', (select g.title from public.whatsapp_groups g where g.id = c.group_id),
   'items', (select jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'summary', i.summary,
     'urgency', i.urgency, 'asks', i.asks,
     'first', to_char(i.first_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'),
     'last', to_char(i.last_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'),
     'quotes', (select jsonb_agg(left(x.speaker || ': ' || x.quote, 300) order by x.at) from (select * from public.personal_radar_mentions m
      where m.item_id = i.id order by m.at desc limit 5) x)) order by i.first_at)
    from public.personal_radar_items i where i.group_id = c.group_id and i.status = 'open'))), '[]')
 into v_out from claimed c;
 return v_out;
end $$;

-- O resultado: p_merges = [{into, items: [ids], kind?, title?, summary?}].
create function public.ai_personal_radar_consolidate_store(p_secret text, p_group uuid, p_merges jsonb,
 p_usage jsonb default '{}') returns integer
language plpgsql security definer set search_path = '' as $$
declare x jsonb; n integer := 0; v_people uuid[]; v_cost numeric; g public.whatsapp_groups; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into g from public.whatsapp_groups where id = p_group;
 for x in select * from jsonb_array_elements(case when jsonb_typeof(p_merges) = 'array' then p_merges else '[]' end) loop
  continue when coalesce(x->>'into', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  if mavi_private.personal_radar_merge((x->>'into')::uuid,
   (select coalesce(array_agg(i.id), '{}') from public.personal_radar_items i
    where i.group_id = p_group and i.status = 'open'
     and i.id::text in (select jsonb_array_elements_text(case when jsonb_typeof(x->'items') = 'array' then x->'items' else '[]' end))),
   x->>'title', x->>'summary', x->>'kind') is not null then
   n := n + 1;
  end if;
 end loop;
 update public.personal_radar_groups set consolidated_at = now(), claimed_until = null where group_id = p_group;
 -- O custo, dividido entre os donos das situações abertas do grupo.
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 select coalesce(array_agg(distinct o.user_id), '{}') into v_people from public.personal_radar_owners o
 join public.personal_radar_items i on i.id = o.item_id where i.group_id = p_group and i.status = 'open';
 if v_cost > 0 and cardinality(v_people) > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens, cost_usd,
   provider_id, provider_name)
  select g.company_id, u, 'personal_radar', 'consolidate', g.client_id, left(coalesce(p_usage->>'model', ''), 80),
   coalesce((p_usage->>'input')::integer, 0) / cardinality(v_people), coalesce((p_usage->>'output')::integer, 0) / cardinality(v_people),
   round(v_cost / cardinality(v_people), 6),
   case when (p_usage->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120)
  from unnest(v_people) u;
 end if;
 return n;
end $$;

revoke all on function public.ai_personal_radar_consolidate_claim(text, integer),
 public.ai_personal_radar_consolidate_store(text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ai_personal_radar_consolidate_claim(text, integer),
 public.ai_personal_radar_consolidate_store(text, uuid, jsonb, jsonb) to anon, authenticated;

-- A consolidação também acorda o worker.
create or replace function mavi_private.personal_radar_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.personal_radar_people p where p.active
   and mavi_private.personal_radar_due(p.company_id))
  and not exists (select 1 from public.personal_radar_learning q
   where (q.claimed_until is null or q.claimed_until < now()) and q.attempts < 5
    and (q.learned_at is null or q.dirty_at > q.learned_at)
    and exists (select 1 from public.personal_radar_feedback f where f.company_id = q.company_id and f.user_id = q.user_id
     and f.learned_at is null and (f.created_at < now() - interval '30 minutes'
      or (select count(*) from public.personal_radar_feedback g where g.company_id = q.company_id and g.user_id = q.user_id
       and g.learned_at is null) >= 3)))
  and not exists (select 1 from public.personal_radar_lessons l where l.status = 'checking' and l.check_attempts < 3
   and (l.check_claimed_until is null or l.check_claimed_until < now()))
  and not exists (select 1 from public.personal_radar_groups q
   where (q.claimed_until is null or q.claimed_until < now())
    and (select count(*) from public.personal_radar_items i where i.group_id = q.group_id and i.status = 'open') >= 2
    and (q.consolidated_at is null or exists (select 1 from public.personal_radar_items i where i.group_id = q.group_id
     and i.status = 'open' and i.updated_at > q.consolidated_at))) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-personal-radar"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 290000);
end $$;

-- ------------------------------------------------------------ a pessoa junta
-- "Juntar com…": p_sources entram em p_target (a pessoa é dona de todos e
-- são do mesmo grupo). Fica no aprendizado.
create function public.personal_radar_join(p_company uuid, p_target uuid, p_sources uuid[], p_title text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); t public.personal_radar_items; v_kept uuid; v_titles jsonb; begin
 select i.* into t from public.personal_radar_items i
 join public.personal_radar_owners o on o.item_id = i.id and o.user_id = v_me
 where i.company_id = p_company and i.id = p_target;
 if not found or not mavi_private.member(p_company) then raise exception 'Item não encontrado' using errcode = 'P0002'; end if;
 if exists (select 1 from unnest(coalesce(p_sources, '{}')) s where not exists (select 1 from public.personal_radar_items i
  join public.personal_radar_owners o on o.item_id = i.id and o.user_id = v_me
  where i.id = s and i.group_id = t.group_id)) then
  raise exception 'Só dá para juntar situações suas do mesmo grupo.' using errcode = '22023';
 end if;
 if length(coalesce(p_title, '')) > 200 then raise exception 'Use um título de até 200 caracteres.' using errcode = '22023'; end if;
 select jsonb_agg(i.title) into v_titles from public.personal_radar_items i where i.id = any(p_sources);
 v_kept := mavi_private.personal_radar_merge(p_target, p_sources, p_title, null, null);
 if v_kept is null then raise exception 'Escolha outra situação para juntar.' using errcode = '22023'; end if;
 insert into public.personal_radar_feedback(company_id, item_id, user_id, action, note, snapshot)
 values (p_company, v_kept, v_me, 'merged', '',
  jsonb_build_object('kind', t.kind, 'title', coalesce(nullif(btrim(p_title), ''), t.title),
   -- O aprendizado lê o resumo: o que foi juntado a esta situação.
   'summary', left('A pessoa juntou nesta situação: ' || (select string_agg('"' || x || '"', '; ')
    from jsonb_array_elements_text(coalesce(v_titles, '[]')) x) || '. Eram a mesma demanda.', 300),
   'client', (select name from public.clients where id = t.client_id), 'merged', v_titles));
 select * into t from public.personal_radar_items where id = v_kept;
 return mavi_private.personal_radar_item_json(t, v_me);
end $$;
revoke all on function public.personal_radar_join(uuid, uuid, uuid[], text) from public, anon;
grant execute on function public.personal_radar_join(uuid, uuid, uuid[], text) to authenticated;

commit;
