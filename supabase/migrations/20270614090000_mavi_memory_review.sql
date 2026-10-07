begin;

-- MAVI · memória por pessoa e por cliente, Fase 3 (pedido de 07/10/2026):
--
-- 1. Revisão semanal (mavi_private.memory_review_run, segunda 8h):
--    - ficha da pessoa com muitos itens: a rotina diária faz uma revisão
--      (junta repetidos, aposenta o que não vale) na próxima passada;
--    - dossiê: itens de histórico da MAVI antigos (120 dias sem evidência
--      nova) viram "Ainda vale?" para quem trabalha com o cliente;
--    - o resumo da semana na caixa de entrada de quem trabalha com cada
--      cliente (o que a MAVI pôs sozinha, o que espera confirmação; os
--      contestados para os líderes, se o painel deixar).
-- 2. Item de situação vencido da pessoa: a MAVI pergunta na conversa seguinte
--    ("Isso ainda vale?"), no máximo uma vez a cada 14 dias por item.
-- 3. Autonomia conforme o acerto: num tipo de item, se quase tudo que a MAVI
--    sugeriu vem sendo confirmado (padrão: 18 das últimas 20) e quase nada
--    foi contestado (menos de 3 em 30 dias), a sugestão desse tipo entra
--    direto (status auto; continua contestável). Condição comercial,
--    contradição e falta de conferência sempre pedem confirmação.
-- 4. A rotina "Memória" nos Avisos de falhas.
-- 5. A medição (mavi_memory_stats): 👍/👎 e a conferência do Jev com e sem
--    memória, as sugestões por status, a autonomia por tipo, os mais
--    contestados e o custo.

-- ------------------------------------------------------------ configuração
create table mavi_private.memory_settings (
 company_id uuid primary key references public.companies(id) on delete cascade,
 dossier_autonomy boolean not null default true,
 autonomy_window integer not null default 20 check (autonomy_window between 10 and 50),
 autonomy_rate numeric not null default 0.9 check (autonomy_rate between 0.7 and 1),
 contest_limit integer not null default 3 check (contest_limit between 1 and 20),
 history_days integer not null default 120 check (history_days between 30 and 365),
 summary_leaders boolean not null default false,
 updated_by uuid,
 updated_at timestamptz not null default now()
);
alter table mavi_private.memory_settings enable row level security;
revoke all on mavi_private.memory_settings from public, anon, authenticated;

create function mavi_private.memory_settings_of(c uuid) returns mavi_private.memory_settings
language sql stable security definer set search_path = '' as $$
 select coalesce((select s from mavi_private.memory_settings s where s.company_id = c),
  row(c, true, 20, 0.9, 3, 120, false, null, now())::mavi_private.memory_settings)
$$;

create function public.mavi_memory_settings(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s mavi_private.memory_settings; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem a memória da MAVI.' using errcode = '42501';
 end if;
 s := mavi_private.memory_settings_of(p_company);
 return jsonb_build_object('dossier_autonomy', s.dossier_autonomy, 'autonomy_window', s.autonomy_window,
  'autonomy_rate', s.autonomy_rate, 'contest_limit', s.contest_limit, 'history_days', s.history_days,
  'summary_leaders', s.summary_leaders, 'updated_by', s.updated_by, 'updated_at', s.updated_at);
end $$;

create function public.save_mavi_memory_settings(p_company uuid, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.memory_settings; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores mudam a memória da MAVI.' using errcode = '42501';
 end if;
 s := mavi_private.memory_settings_of(p_company);
 insert into mavi_private.memory_settings(company_id, dossier_autonomy, autonomy_window, autonomy_rate, contest_limit,
  history_days, summary_leaders, updated_by, updated_at)
 values (p_company,
  coalesce((p_settings->>'dossier_autonomy')::boolean, s.dossier_autonomy),
  coalesce((p_settings->>'autonomy_window')::integer, s.autonomy_window),
  coalesce((p_settings->>'autonomy_rate')::numeric, s.autonomy_rate),
  coalesce((p_settings->>'contest_limit')::integer, s.contest_limit),
  coalesce((p_settings->>'history_days')::integer, s.history_days),
  coalesce((p_settings->>'summary_leaders')::boolean, s.summary_leaders),
  auth.uid(), now())
 on conflict (company_id) do update set dossier_autonomy = excluded.dossier_autonomy,
  autonomy_window = excluded.autonomy_window, autonomy_rate = excluded.autonomy_rate,
  contest_limit = excluded.contest_limit, history_days = excluded.history_days,
  summary_leaders = excluded.summary_leaders, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
 return public.mavi_memory_settings(p_company);
end $$;

-- ------------------------------------------------------------ sugestões
-- review: "Ainda vale?" de um item de histórico antigo · auto: a sugestão
-- entrou sozinha pela autonomia do tipo.
alter table public.client_dossier_proposals drop constraint client_dossier_proposals_op_check;
alter table public.client_dossier_proposals add constraint client_dossier_proposals_op_check
 check (op in ('add', 'update', 'remove', 'contest', 'review'));
alter table public.client_dossier_proposals drop constraint client_dossier_proposals_status_check;
alter table public.client_dossier_proposals add constraint client_dossier_proposals_status_check
 check (status in ('suggested', 'confirmed', 'refused', 'expired', 'rejected', 'contested', 'restored', 'discarded',
  'auto'));
create index client_dossier_proposals_company on public.client_dossier_proposals (company_id, kind, decided_at desc)
 where status in ('confirmed', 'refused');

-- O que a autonomia pode pular (o resto sempre pede confirmação).
create function mavi_private.dossier_autonomy_reasons() returns text[]
language sql immutable set search_path = '' as $$ select array['regra ou combinado', 'pouca evidência'] $$;

-- O acerto de um tipo de item na empresa: as últimas N sugestões decididas
-- por pessoas (add/update) e as contestações de itens da MAVI em 30 dias.
create function mavi_private.dossier_autonomy(c uuid, p_kind text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s mavi_private.memory_settings := mavi_private.memory_settings_of(c); v_decided integer; v_ok integer;
 v_contests integer; begin
 select count(*), count(*) filter (where x.status = 'confirmed') into v_decided, v_ok from (
  select p.status from public.client_dossier_proposals p where p.company_id = c and p.kind = p_kind
   and p.op in ('add', 'update') and p.status in ('confirmed', 'refused')
  order by p.decided_at desc limit s.autonomy_window) x;
 select count(*) into v_contests from public.client_dossier_proposals p
 where p.company_id = c and p.kind = p_kind and p.op = 'contest' and p.created_at > now() - interval '30 days'
  and p.snapshot->>'origin' = 'mavi';
 return jsonb_build_object('kind', p_kind, 'decided', v_decided, 'confirmed', v_ok, 'window', s.autonomy_window,
  'rate', case when v_decided > 0 then round(v_ok::numeric / v_decided, 3) end, 'contests', v_contests,
  'auto', s.dossier_autonomy and v_decided >= s.autonomy_window and v_ok::numeric / greatest(v_decided, 1) >= s.autonomy_rate
   and v_contests < s.contest_limit);
end $$;

-- Confirmar ou recusar; no "Ainda vale?", confirmar mantém (com evidência
-- de agora) e recusar tira o item.
create or replace function public.client_dossier_decide(p_company uuid, p_proposal uuid, p_decision text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.client_dossier_proposals; begin
 select * into p from public.client_dossier_proposals x where x.id = p_proposal and x.company_id = p_company for update;
 if p.id is null or not mavi_private.dossier_reader(p_company, p.client_id) then
  raise exception 'Sugestão não encontrada.' using errcode = 'P0002';
 end if;
 if coalesce(p_decision, '') not in ('confirm', 'refuse') then
  raise exception 'Decisão inválida.' using errcode = '22023';
 end if;
 if p.status <> 'suggested' or p.expires_at < now() then
  return jsonb_build_object('id', p.id, 'status', case when p.status = 'suggested' then 'expired' else p.status end);
 end if;
 if p_decision = 'confirm' then
  if p.op = 'add' then
   if not exists (select 1 from public.client_dossier_items i where i.client_id = p.client_id
    and lower(i.text) = lower(p.text)) then
    insert into public.client_dossier_items(company_id, client_id, kind, text, origin, sources, seen_at, created_by)
    values (p.company_id, p.client_id, p.kind, p.text, 'mavi', p.sources, coalesce(p.seen_at, now()), auth.uid());
   end if;
  elsif p.op = 'update' then
   update public.client_dossier_items i set text = p.text, kind = p.kind,
    sources = case when jsonb_array_length(p.sources) > 0 then p.sources else i.sources end,
    seen_at = coalesce(p.seen_at, i.seen_at), updated_by = auth.uid(), updated_at = now()
   where i.id = p.item_id and i.client_id = p.client_id and i.origin = 'mavi' and not i.pinned and not i.dismissed;
  elsif p.op = 'remove' then
   delete from public.client_dossier_items i
   where i.id = p.item_id and i.client_id = p.client_id and i.origin = 'mavi' and not i.pinned and not i.dismissed;
  elsif p.op = 'review' then
   update public.client_dossier_items i set seen_at = now(), updated_by = auth.uid(), updated_at = now()
   where i.id = p.item_id and i.client_id = p.client_id;
  end if;
 elsif p.op = 'review' then
  delete from public.client_dossier_items i
  where i.id = p.item_id and i.client_id = p.client_id and i.origin = 'mavi' and not i.pinned and not i.dismissed;
 end if;
 update public.client_dossier_proposals set status = case when p_decision = 'confirm' then 'confirmed' else 'refused' end,
  decided_by = auth.uid(), decided_at = now()
 where id = p.id;
 perform mavi_private.dossier_bump(p.client_id);
 return jsonb_build_object('id', p.id, 'status', case when p_decision = 'confirm' then 'confirmed' else 'refused' end);
end $$;

-- A rotina do dossiê (20270613090000), com a autonomia: a sugestão de um tipo
-- que a MAVI vem acertando, só com motivos que a autonomia pode pular, entra
-- direto e fica registrada como auto.
create or replace function public.ai_dossier_store(p_secret text, p_client uuid, p_cursor_at timestamptz,
 p_cursor_id uuid, p_more boolean, p_ops jsonb, p_usage jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.client_dossier_state; o jsonb; v_changed integer := 0; v_n integer; v_kind text;
 v_text text; v_sources jsonb; v_seen timestamptz; v_id uuid; v_route text; v_item public.client_dossier_items;
 v_reasons text[]; v_checks jsonb; v_jev jsonb; v_auto boolean; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into s from mavi_private.client_dossier_state where client_id = p_client for update;
 if not found then return 0; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_kind := o->>'kind';
  v_text := btrim(coalesce(o->>'text', ''));
  v_sources := case when jsonb_typeof(o->'sources') = 'array' then o->'sources' else '[]' end;
  v_seen := case when o->>'seen_at' ~ '^\d{4}-\d{2}-\d{2}' then (o->>'seen_at')::timestamptz end;
  v_id := case when o->>'id' ~* '^[0-9a-f-]{36}$' then (o->>'id')::uuid end;
  v_route := case when o->>'route' in ('suggest', 'refuse') then o->>'route' else 'apply' end;
  v_reasons := array(select left(r, 120) from jsonb_array_elements_text(
   case when jsonb_typeof(o->'reasons') = 'array' then o->'reasons' else '[]' end) r limit 6);
  v_checks := case when jsonb_typeof(o->'checks') = 'object' then o->'checks' else '{}' end;
  v_auto := false;
  if v_route = 'suggest' and coalesce(o->>'op', '') in ('add', 'update')
   and v_reasons <@ mavi_private.dossier_autonomy_reasons()
   and v_kind in ('prefers', 'avoids', 'rule', 'style', 'context', 'history')
   and coalesce((mavi_private.dossier_autonomy(s.company_id, v_kind)->>'auto')::boolean, false) then
   v_auto := true;
  end if;
  if v_route <> 'apply' then
   v_item := null;
   if o->>'op' in ('update', 'remove') then
    select * into v_item from public.client_dossier_items i where i.id = v_id and i.client_id = p_client
     and i.origin = 'mavi' and not i.pinned and not i.dismissed;
    continue when v_item.id is null;
    if o->>'op' = 'remove' then v_text := v_item.text; v_kind := v_item.kind; end if;
   end if;
   v_kind := coalesce(case when v_kind in ('prefers', 'avoids', 'rule', 'style', 'context', 'history') then v_kind end,
    v_item.kind);
   continue when coalesce(o->>'op', '') not in ('add', 'update', 'remove') or v_kind is null
    or length(v_text) not between 3 and 600;
   continue when o->>'op' = 'add' and exists (select 1 from public.client_dossier_items i where i.client_id = p_client
    and lower(i.text) = lower(v_text));
   continue when mavi_private.dossier_seen_text(p_client, v_text, not v_auto);
   if v_auto then
    continue when o->>'op' = 'add' and (select count(*) from public.client_dossier_items i where i.client_id = p_client
     and not i.dismissed) >= 60;
    if o->>'op' = 'add' then
     insert into public.client_dossier_items(company_id, client_id, kind, text, origin, sources, seen_at)
     values (s.company_id, p_client, v_kind, v_text, 'mavi', v_sources, coalesce(v_seen, now()));
    else
     update public.client_dossier_items i set text = v_text, kind = v_kind,
      sources = case when jsonb_array_length(v_sources) > 0 then v_sources else i.sources end,
      seen_at = coalesce(v_seen, i.seen_at), updated_by = null, updated_at = now()
     where i.id = v_item.id;
    end if;
   end if;
   insert into public.client_dossier_proposals(company_id, client_id, op, item_id, kind, text, previous, sources,
    seen_at, reasons, note, checks, status, expires_at, decided_at)
   values (s.company_id, p_client, o->>'op', v_item.id, v_kind, v_text,
    case when o->>'op' = 'update' then v_item.text end, v_sources, v_seen, v_reasons,
    nullif(left(coalesce(o->>'note', ''), 500), ''), v_checks,
    case when v_auto then 'auto' when v_route = 'suggest' then 'suggested' else 'rejected' end,
    case when v_route = 'suggest' and not v_auto then now() + mavi_private.dossier_suggestion_days() end,
    case when v_auto then now() end);
   v_changed := v_changed + case when v_route = 'suggest' then 1 else 0 end;
  elsif o->>'op' = 'add' then
   continue when v_kind is null or v_kind not in ('prefers', 'avoids', 'rule', 'style', 'context', 'history')
    or length(v_text) not between 3 and 600;
   continue when exists (select 1 from public.client_dossier_items i where i.client_id = p_client
    and lower(i.text) = lower(v_text));
   continue when mavi_private.dossier_seen_text(p_client, v_text, false);
   continue when (select count(*) from public.client_dossier_items i where i.client_id = p_client
    and not i.dismissed) >= 60;
   insert into public.client_dossier_items(company_id, client_id, kind, text, origin, sources, seen_at)
   values (s.company_id, p_client, v_kind, v_text, 'mavi', v_sources, coalesce(v_seen, now()));
   v_changed := v_changed + 1;
  elsif o->>'op' = 'update' and v_id is not null then
   continue when length(v_text) not between 3 and 600;
   update public.client_dossier_items i set text = v_text,
    kind = case when v_kind in ('prefers', 'avoids', 'rule', 'style', 'context', 'history') then v_kind else i.kind end,
    sources = case when jsonb_array_length(v_sources) > 0 then v_sources else i.sources end,
    seen_at = coalesce(v_seen, i.seen_at), updated_by = null, updated_at = now()
   where i.id = v_id and i.client_id = p_client and i.origin = 'mavi' and not i.pinned and not i.dismissed;
   get diagnostics v_n = row_count; v_changed := v_changed + v_n;
  elsif o->>'op' = 'remove' and v_id is not null then
   delete from public.client_dossier_items i
   where i.id = v_id and i.client_id = p_client and i.origin = 'mavi' and not i.pinned and not i.dismissed;
   get diagnostics v_n = row_count; v_changed := v_changed + v_n;
  end if;
 end loop;
 update mavi_private.client_dossier_state set built_at = now(), running_until = null, attempts = 0, last_error = null,
  cursor_at = coalesce(p_cursor_at, cursor_at), cursor_id = coalesce(p_cursor_id, cursor_id),
  version = version + case when v_changed > 0 then 1 else 0 end,
  dirty_at = case when p_more then now() - interval '1 hour'
   when dirty_at > claimed_at then dirty_at else null end
 where client_id = p_client;
 if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (s.company_id, null, 'tasks', 'dossier', p_client, left(coalesce(p_usage->>'model', ''), 80),
   greatest(coalesce((p_usage->>'input')::integer, 0), 0), greatest(coalesce((p_usage->>'output')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_read')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100),
   case when p_usage->>'provider_id' ~* '^[0-9a-f-]{36}$' then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
  v_jev := p_usage->'jev';
  if jsonb_typeof(v_jev) = 'object' then
   insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, cost_usd,
    provider_id, provider_name)
   values (s.company_id, null, 'tasks', 'dossier_check', p_client, left(coalesce(v_jev->>'model', ''), 80),
    greatest(coalesce((v_jev->>'input')::integer, 0), 0),
    least(greatest(coalesce((v_jev->>'cost')::numeric, 0), 0), 100),
    case when v_jev->>'provider_id' ~* '^[0-9a-f-]{36}$' then (v_jev->>'provider_id')::uuid end,
    left(coalesce(v_jev->>'provider', ''), 120));
  end if;
 end if;
 return v_changed;
end $$;

-- ------------------------------------------------------------ pessoa
alter table public.mavi_person_traits add column review_asked_at timestamptz;
alter table mavi_private.mavi_person_state add column review_due boolean not null default false;

-- A fila da rotina diária: a revisão semanal entra mesmo lida hoje.
create or replace function mavi_private.mavi_person_due() returns table(company_id uuid, user_id uuid)
language sql stable security definer set search_path = '' as $$
 select s.company_id, s.user_id from mavi_private.mavi_person_state s
 where s.dirty_at is not null and s.attempts < 5
  and (s.running_until is null or s.running_until < now())
  and s.dirty_at <= now() - interval '15 minutes'
  and (s.review_due or s.built_at is null or s.built_at < now() - interval '1 day'
   or (s.urgent and s.built_at < now() - interval '1 hour'))
$$;

-- A leitura da rotina (20270611090000), dizendo quando é a revisão semanal.
create or replace function public.mavi_person_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.mavi_person_state; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select x.* into s from mavi_private.mavi_person_state x
 where (x.company_id, x.user_id) in (select d.company_id, d.user_id from mavi_private.mavi_person_due() d)
 order by x.urgent desc, x.dirty_at limit 1 for update skip locked;
 if s.company_id is null then return null; end if;
 update mavi_private.mavi_person_state set claimed_at = now(), running_until = now() + interval '4 minutes',
  review_due = false
 where company_id = s.company_id and user_id = s.user_id;
 return jsonb_build_object('company', s.company_id, 'user', s.user_id, 'review', s.review_due,
  'name', (select m.name from public.memberships m where m.company_id = s.company_id and m.user_id = s.user_id),
  'facts', mavi_private.mavi_person_facts(s.company_id, s.user_id),
  'items', mavi_private.mavi_person_items(s.company_id, s.user_id, true),
  'feedback', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'vote', f.vote, 'reason', f.reason,
     'comment', f.comment, 'question', left(f.question, 300), 'answer', left(f.answer, 300), 'at', f.updated_at)
     order by f.updated_at desc), '[]')
   from (select * from public.mavi_feedback g where g.company_id = s.company_id and g.user_id = s.user_id
    order by g.updated_at desc limit 40) f),
  'frustrations', (select coalesce(jsonb_agg(jsonb_build_object('message', k.message_id,
     'signals', to_jsonb(k.signals), 'answer', left(m.content, 300),
     'said', (select left(n.content, 300) from public.ai_messages n where n.conversation_id = m.conversation_id
      and n.role = 'user' and n.id > m.id order by n.id limit 1),
     'judge', k.verdict->>'explanation') order by k.updated_at desc), '[]')
   from (select * from public.mavi_answer_checks y where y.company_id = s.company_id and y.user_id = s.user_id
    and y.signals && array['frustration', 'repeated']::text[] order by y.updated_at desc limit 20) k
   join public.ai_messages m on m.id = k.message_id),
  'questions', (select coalesce(jsonb_agg(left(q.content, 200) order by q.id desc), '[]')
   from (select u.id, u.content from public.ai_messages u
    join public.ai_conversations c on c.id = u.conversation_id
    where c.company_id = s.company_id and c.owner_id = s.user_id and u.role = 'user'
     and u.created_at > now() - interval '60 days'
    order by u.id desc limit 40) q),
  'question_ids', (select coalesce(jsonb_agg(q.id order by q.id desc), '[]')
   from (select u.id from public.ai_messages u
    join public.ai_conversations c on c.id = u.conversation_id
    where c.company_id = s.company_id and c.owner_id = s.user_id and u.role = 'user'
     and u.created_at > now() - interval '60 days'
    order by u.id desc limit 40) q));
end $$;

-- "Isso ainda vale?": um item de situação vencido de quem pergunta (no máximo
-- uma vez a cada 14 dias por item).
create function public.mavi_person_review_next(p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.mavi_person_traits; begin
 if auth.uid() is null or not mavi_private.member(p_company) then return null; end if;
 select x.* into t from public.mavi_person_traits x
 where x.company_id = p_company and x.user_id = auth.uid() and not x.dismissed and x.valid_until < now()
  and (x.review_asked_at is null or x.review_asked_at < now() - interval '14 days')
 order by x.valid_until limit 1 for update skip locked;
 if t.id is null then return null; end if;
 update public.mavi_person_traits set review_asked_at = now() where id = t.id;
 return jsonb_build_object('id', t.id, 'kind', t.kind, 'text', t.text, 'valid_until', t.valid_until);
end $$;

-- ------------------------------------------------------------ revisão semanal
do $$ declare v text[]; w text[]; begin
 select coalesce(array_agg(distinct m[1]), '{}') into v from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_kind_check' and k.conrelid = 'public.notifications'::regclass;
 select coalesce(array_agg(distinct m[1]), '{}') into w from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_target_check' and k.conrelid = 'public.notifications'::regclass;
 v := array(select distinct x from unnest(v || array['memory_week']) x order by x);
 w := array(select distinct x from unnest(w || array['memory_week', 'notice']) x order by x);
 alter table public.notifications drop constraint notifications_kind_check;
 execute format('alter table public.notifications add constraint notifications_kind_check check (kind in (%s))',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
 alter table public.notifications drop constraint notifications_target_check;
 execute format('alter table public.notifications add constraint notifications_target_check check ('
  '((kind in (%s)) = (task_id is null)) '
  'and (task_id is not null or (title is not null and link is not null)) '
  'and ((kind = ''notice'') = (notice_id is not null)))', (select string_agg(quote_literal(x), ',') from unnest(w) x));
end $$;

-- Os clientes que uma pessoa atende (equipes do cliente).
create function mavi_private.memory_person_clients(c uuid, u uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
 select distinct ct.client_id from public.client_teams ct
 join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
 join public.clients k on k.company_id = ct.company_id and k.id = ct.client_id and not k.archived
 where ct.company_id = c and tm.user_id = u
$$;

-- Uma empresa: as revisões e o resumo da semana. Devolve quantos avisos.
create function mavi_private.memory_review_company(c uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.memory_settings := mavi_private.memory_settings_of(c); m record; v_lines text[];
 v_top uuid; v_new integer; v_wait integer; v_cont integer; v_sent integer := 0; r record;
 v_mavi uuid := mavi_private.radar_mavi_user(c); begin
 -- Dossiê: histórico da MAVI sem evidência nova há muito tempo → "Ainda vale?".
 insert into public.client_dossier_proposals(company_id, client_id, op, item_id, kind, text, previous, sources, seen_at,
  reasons, status, expires_at)
 select i.company_id, i.client_id, 'review', i.id, i.kind, i.text, null, i.sources, i.seen_at,
  array['histórico antigo: ainda vale?'], 'suggested', now() + mavi_private.dossier_suggestion_days()
 from (select x.*, row_number() over (partition by x.client_id order by x.seen_at) n
  from public.client_dossier_items x
  where x.company_id = c and x.kind = 'history' and x.origin = 'mavi' and not x.pinned and not x.dismissed
   and coalesce(x.seen_at, x.created_at) < now() - make_interval(days => s.history_days)
   and not exists (select 1 from public.client_dossier_proposals p where p.item_id = x.id
    and (p.status in ('suggested', 'contested') or (p.op = 'review' and p.created_at > now() - interval '60 days')))) i
 where i.n <= 10;
 -- Ficha da pessoa com muitos itens: revisão na próxima passada da rotina.
 insert into mavi_private.mavi_person_state(company_id, user_id, dirty_at, review_due)
 select t.company_id, t.user_id, now() - interval '20 minutes', true from public.mavi_person_traits t
 where t.company_id = c and not t.dismissed and t.origin = 'mavi'
 group by t.company_id, t.user_id having count(*) >= 10 or sum(length(t.text)) > 2500
 on conflict (company_id, user_id) do update set review_due = true,
  dirty_at = coalesce(mavi_person_state.dirty_at, excluded.dirty_at);
 -- O resumo da semana, por pessoa.
 for m in select x.user_id, x.role from public.memberships x where x.company_id = c and x.active loop
  v_lines := '{}'; v_top := null;
  for r in
   select k.id, k.name,
    (select count(*) from public.client_dossier_items i where i.client_id = k.id and i.origin = 'mavi'
      and i.created_by is null and i.created_at > now() - interval '7 days' and not i.dismissed)::int as fresh,
    (select count(*) from public.client_dossier_proposals p where p.client_id = k.id and p.status = 'suggested'
      and p.expires_at >= now())::int as waiting,
    (select count(*) from public.client_dossier_proposals p where p.client_id = k.id and p.status = 'contested')::int
     as contested
   from public.clients k
   where k.company_id = c and not k.archived
    and (k.id in (select mavi_private.memory_person_clients(c, m.user_id))
     or (s.summary_leaders and m.role in ('admin', 'manager')))
  loop
   v_new := r.fresh;
   v_wait := r.waiting;
   v_cont := case when m.role in ('admin', 'manager') and s.summary_leaders then r.contested else 0 end;
   continue when v_new + v_wait + v_cont = 0;
   -- Para o líder que não atende o cliente, só os contestados.
   if r.id not in (select mavi_private.memory_person_clients(c, m.user_id)) then
    continue when v_cont = 0;
    v_new := 0; v_wait := 0;
   end if;
   v_lines := v_lines || (r.name || ' (' || concat_ws(', ',
    case when v_wait > 0 then v_wait || ' para confirmar' end,
    case when v_new > 0 then v_new || case when v_new = 1 then ' novo' else ' novos' end end,
    case when v_cont > 0 then v_cont || case when v_cont = 1 then ' contestado' else ' contestados' end end) || ')');
   if v_top is null and (v_wait > 0 or v_cont > 0) then v_top := r.id; end if;
   if v_top is null then v_top := r.id; end if;
  end loop;
  continue when cardinality(v_lines) = 0;
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
  values (c, m.user_id, v_mavi, null, 'memory_week',
   'Dossiês da semana: ' || cardinality(v_lines) || case when cardinality(v_lines) = 1 then ' cliente' else ' clientes' end
    || ' com novidades',
   left(array_to_string(v_lines[1:6], ' · ') || coalesce(case when cardinality(v_lines) > 6 then ' · e mais '
    || (cardinality(v_lines) - 6) end, ''), 300),
   '/drive/cliente/' || v_top || '/dossie');
  v_sent := v_sent + 1;
 end loop;
 return v_sent;
end $$;

-- pg_cron (segunda, 8h de Brasília): cada empresa à parte; a falha de uma vai
-- para os Avisos de falhas e não para as outras.
create function mavi_private.memory_review_run() returns integer
language plpgsql security definer set search_path = '' as $$
declare c uuid; v_total integer := 0; begin
 for c in select k.id from public.companies k loop
  begin
   v_total := v_total + mavi_private.memory_review_company(c);
   perform mavi_private.job_report(c, 'memory', true);
  exception when others then
   perform mavi_private.job_report(c, 'memory', false, sqlerrm);
  end;
 end loop;
 return v_total;
end $$;

do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.schedule('mavi-memory-review', '0 11 * * 1', 'select mavi_private.memory_review_run()');
 end if;
end $$;

-- Os Avisos de falhas (20270520090000), com a revisão semanal da memória.
create or replace function mavi_private.job_catalog()
returns table(job text, sort integer, label text, noun text, nouns text, fails boolean, stale_ok boolean,
 fail_after integer, stale_hours integer, link text)
language sql immutable set search_path = '' as $$
 values
  ('whatsapp_sweep', 1, 'Varredura do WhatsApp', null::text, null::text, true, true, 3, 6,
   '/mavi#whatsapp'),
  ('whatsapp_groups', 2, 'Leitura dos grupos do WhatsApp', 'grupo', 'grupos', true, false, 3, null::integer,
   '/mavi#whatsapp'),
  ('ads_sync', 3, 'Sincronização diária das campanhas', 'campanha', 'campanhas', true, true, 1, 30, '/campanhas'),
  ('ads_today', 4, 'Resultados de hoje das campanhas', 'campanha', 'campanhas', true, true, 4, null, '/campanhas'),
  ('campaign_insights', 5, 'Insights da MAVI nas campanhas', 'campanha', 'campanhas', true, false, 1, null,
   '/campanhas'),
  ('campaign_daily', 6, 'Leitura do dia da MAVI', 'campanha', 'campanhas', true, true, 1, null, '/campanhas'),
  ('make_leads', 7, 'Leads da página de captura da Make', null, null, false, true, null, 24, '/campanhas'),
  ('agent_sync', 8, 'Leitura do Agente Conversacional (n8n)', 'servidor', 'servidores', true, true, 2, 3,
   '/agente-conversacional'),
  ('social_media', 9, 'Publicação automática do Social Media', null, null, true, false, 1, null,
   '/planejamento/social-media'),
  ('radar', 10, 'Leituras do Radar do cliente', null, null, true, true, 3, null, '/radar'),
  ('temperature', 11, 'Leituras do Termômetro', null, null, true, true, 3, null, '/termometro'),
  ('task_recurrences', 12, 'Repetição de tarefas', 'tarefa', 'tarefas', true, false, 1, null, '/tarefas'),
  ('cs_sync', 13, 'Leitura da planilha de CS', null, null, true, true, 3, 2, '/configuracoes#config-cs'),
  ('memory', 14, 'Revisão semanal da memória da MAVI', null, null, true, true, 1, 192, '/mavi#memoria')
$$;

-- ------------------------------------------------------------ medição
create function public.mavi_memory_stats(p_company uuid, p_days integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 7), 365)); begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem a memória da MAVI.' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'days', least(greatest(coalesce(p_days, 30), 7), 365),
  'answers', (select jsonb_object_agg(g.side, jsonb_build_object('answers', g.answers, 'up', g.up, 'down', g.down,
     'judged', g.judged, 'judged_ok', g.judged_ok)) from (
    select case when jsonb_array_length(m.memory) > 0 or jsonb_array_length(m.dossier) > 0 then 'with' else 'without' end
      as side,
     count(*)::int as answers,
     count(*) filter (where f.vote = 'up')::int as up,
     count(*) filter (where f.vote = 'down')::int as down,
     count(*) filter (where k.status = 'done')::int as judged,
     count(*) filter (where k.status = 'done' and not (coalesce((k.verdict->>'ok')::boolean, true) = false
      and coalesce((k.verdict->>'confidence')::numeric, 0) >= 0.6))::int as judged_ok
    from public.ai_messages m
    left join lateral (select x.vote from public.mavi_feedback x where x.message_id = m.id
     order by x.updated_at desc limit 1) f on true
    left join public.mavi_answer_checks k on k.message_id = m.id
    where m.company_id = p_company and m.role = 'assistant' and m.created_at > v_since
    group by 1) g),
  'person', jsonb_build_object(
   'noted', (select count(*) from public.mavi_person_trait_log l where l.company_id = p_company and l.actor = 'mavi'
     and l.by is not null and l.action in ('add', 'edit') and l.at > v_since)::int,
   'undone', (select count(*) from public.mavi_person_trait_log l where l.company_id = p_company and l.actor = 'person'
     and l.action = 'dismiss' and l.at > v_since)::int,
   'learned', (select count(*) from public.mavi_person_trait_log l where l.company_id = p_company and l.actor = 'mavi'
     and l.by is null and l.action = 'add' and l.at > v_since)::int,
   'expired', (select count(*) from public.mavi_person_traits t where t.company_id = p_company and not t.dismissed
     and t.valid_until < now())::int,
   'people', (select count(distinct t.user_id) from public.mavi_person_traits t where t.company_id = p_company
     and not t.dismissed)::int),
  'proposals', (select coalesce(jsonb_object_agg(x.status, x.n), '{}') from (
    select p.status, count(*)::int n from public.client_dossier_proposals p
    where p.company_id = p_company and p.created_at > v_since group by p.status) x),
  'applied', (select count(*) from public.client_dossier_items i where i.company_id = p_company and i.origin = 'mavi'
    and i.created_by is null and i.created_at > v_since)::int,
  'autonomy', (select jsonb_agg(mavi_private.dossier_autonomy(p_company, k) order by o)
   from unnest(array['prefers', 'avoids', 'rule', 'style', 'context', 'history']) with ordinality u(k, o)),
  'contested', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'client', k.name, 'client_id', p.client_id,
     'kind', p.kind, 'text', p.text, 'reason', p.contest_reason, 'status', p.status, 'origin', p.snapshot->>'origin',
     'by', p.created_by, 'at', p.created_at) order by p.created_at desc), '[]')
   from (select * from public.client_dossier_proposals x where x.company_id = p_company and x.op = 'contest'
    and x.created_at > v_since order by x.created_at desc limit 15) p
   join public.clients k on k.company_id = p.company_id and k.id = p.client_id),
  'cost', (select coalesce(jsonb_object_agg(x.kind, x.cost), '{}') from (
    select u.kind, round(sum(u.cost_usd), 4) cost from public.ai_usage u where u.company_id = p_company
     and u.kind in ('dossier', 'dossier_check', 'profile') and u.created_at > v_since group by u.kind) x),
  'settings', public.mavi_memory_settings(p_company));
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.memory_settings_of(uuid), mavi_private.dossier_autonomy_reasons(),
 mavi_private.dossier_autonomy(uuid, text), mavi_private.memory_person_clients(uuid, uuid),
 mavi_private.memory_review_company(uuid), mavi_private.memory_review_run() from public, anon, authenticated;
revoke all on function public.mavi_memory_settings(uuid), public.save_mavi_memory_settings(uuid, jsonb),
 public.mavi_person_review_next(uuid), public.mavi_memory_stats(uuid, integer) from public, anon;
grant execute on function public.mavi_memory_settings(uuid), public.save_mavi_memory_settings(uuid, jsonb),
 public.mavi_person_review_next(uuid), public.mavi_memory_stats(uuid, integer) to authenticated;

commit;
