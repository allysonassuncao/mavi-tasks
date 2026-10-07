begin;

-- MAVI · memória por pessoa, Fase 1 (pedido de 07/10/2026), sobre a base de
-- comportamento (20270117090000_mavi_person):
--
-- 1. Estável × situação: um item de situação ("está fechando o mês do
--    cliente X") vale 60 dias (valid_until). Vencido, não entra na pergunta
--    nem no juiz; a pessoa renova na tela, ou a MAVI renova quando as
--    novidades mostram que continua valendo.
-- 2. De onde veio (sources): as avaliações, as conferências, as perguntas ou
--    a conversa em que a pessoa disse.
-- 3. Anotado na conversa (mavi_person_note): quando a pessoa diz com todas as
--    letras como quer as respostas, o que evitar, ou corrige um item, a MAVI
--    grava na hora, com Desfazer. No máximo 6 por hora.
-- 4. Memória usada (ai_messages.memory): cada resposta guarda quais itens leu
--    (só os ids: quem vê a conversa compartilhada não vê os textos); o chip
--    mostra e retira.
-- 5. Histórico (mavi_person_trait_log): toda mudança, de quem e quando.

alter table public.mavi_person_traits
 add column durability text not null default 'stable' check (durability in ('stable', 'situation')),
 add column valid_until timestamptz,
 add column sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array');
alter table public.mavi_person_traits add constraint mavi_person_traits_validity
 check ((durability = 'situation') = (valid_until is not null));

-- Quanto vale um item de situação.
create function mavi_private.mavi_person_valid_for() returns interval
language sql immutable set search_path = '' as $$ select interval '60 days' $$;

-- ------------------------------------------------------------ histórico
create table public.mavi_person_trait_log (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 -- Sem chave estrangeira: o item aposentado pela MAVI é apagado.
 trait_id uuid not null,
 action text not null check (action in ('add', 'edit', 'retire', 'dismiss', 'restore', 'pin', 'unpin', 'renew')),
 kind text not null,
 text_before text,
 text_after text,
 -- Quem mudou: a MAVI (a rotina ou a conversa), a pessoa ou um líder.
 actor text not null check (actor in ('mavi', 'person', 'leader')),
 by uuid,
 at timestamptz not null default now()
);
create index mavi_person_trait_log_user on public.mavi_person_trait_log (company_id, user_id, at desc);
alter table public.mavi_person_trait_log enable row level security;
revoke all on public.mavi_person_trait_log from public, anon, authenticated;

create function mavi_private.mavi_person_trait_logger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.mavi_person_traits; v_action text; v_by uuid := auth.uid(); v_actor text; begin
 r := case when tg_op = 'DELETE' then old else new end;
 if tg_op = 'INSERT' then v_action := 'add';
 elsif tg_op = 'DELETE' then v_action := 'retire';
 elsif new.text is distinct from old.text or new.kind is distinct from old.kind
  or new.durability is distinct from old.durability then v_action := 'edit';
 elsif new.dismissed and not old.dismissed then v_action := 'dismiss';
 elsif old.dismissed and not new.dismissed then v_action := 'restore';
 elsif new.pinned and not old.pinned then v_action := 'pin';
 elsif old.pinned and not new.pinned then v_action := 'unpin';
 elsif new.valid_until > old.valid_until then v_action := 'renew';
 else return null;
 end if;
 -- A anotação na conversa é da MAVI, mesmo pedida pela pessoa.
 v_actor := coalesce(nullif(current_setting('mavi.person_actor', true), ''),
  case when v_by is null then 'mavi' when v_by = r.user_id then 'person' else 'leader' end);
 insert into public.mavi_person_trait_log(company_id, user_id, trait_id, action, kind, text_before, text_after, actor, by)
 values (r.company_id, r.user_id, r.id, v_action, r.kind,
  case when tg_op <> 'INSERT' then old.text end, case when tg_op <> 'DELETE' then new.text end, v_actor, v_by);
 return null;
end $$;
create trigger mavi_person_trait_log after insert or update or delete on public.mavi_person_traits
 for each row execute function mavi_private.mavi_person_trait_logger();

-- ------------------------------------------------------------ memória usada
alter table public.ai_messages add column memory jsonb not null default '[]' check (jsonb_typeof(memory) = 'array');

-- A resposta guarda quais itens da memória de quem perguntou ela leu.
create function public.mavi_person_used(p_message bigint, p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.ai_conversations; begin
 select v.* into c from public.ai_messages m join public.ai_conversations v on v.id = m.conversation_id
 where m.id = p_message and m.role = 'assistant';
 if c.id is null or c.owner_id is distinct from auth.uid() or not mavi_private.member(c.company_id) then
  raise exception 'Resposta não encontrada.' using errcode = 'P0002';
 end if;
 update public.ai_messages set memory = (select coalesce(jsonb_agg(t.id), '[]') from (
   select x.id from public.mavi_person_traits x where x.company_id = c.company_id and x.user_id = auth.uid()
    and x.id = any(coalesce(p_ids, '{}')) limit 30) t)
 where id = p_message;
end $$;

-- Os itens pelos ids (o chip da resposta e o cartão "Anotei"): só os de quem
-- pode ver a base da pessoa.
create function public.mavi_person_lookup(p_company uuid, p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'user', t.user_id, 'kind', t.kind, 'text', t.text,
   'origin', t.origin, 'pinned', t.pinned, 'dismissed', t.dismissed, 'durability', t.durability,
   'valid_until', t.valid_until, 'expired', coalesce(t.valid_until < now(), false))), '[]')
  from (select x.* from public.mavi_person_traits x where x.company_id = p_company
   and x.id = any(coalesce(p_ids[1:40], '{}')) and mavi_private.mavi_person_viewer(p_company, x.user_id)) t);
end $$;

-- ------------------------------------------------------------ leitura
create or replace function mavi_private.mavi_person_items(c uuid, u uuid, p_with_dismissed boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'text', t.text, 'origin', t.origin,
   'pinned', t.pinned, 'dismissed', t.dismissed, 'updated_at', t.updated_at, 'updated_by', t.updated_by,
   'durability', t.durability, 'valid_until', t.valid_until, 'expired', coalesce(t.valid_until < now(), false),
   'sources', t.sources)
  order by t.kind, t.pinned desc, t.updated_at desc), '[]')
 from public.mavi_person_traits t
 where t.company_id = c and t.user_id = u and (p_with_dismissed or not t.dismissed)
$$;

create or replace function public.mavi_person_profile(p_company uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s mavi_private.mavi_person_state; v_user uuid := coalesce(p_user, auth.uid()); begin
 if not mavi_private.mavi_person_viewer(p_company, v_user) then
  raise exception 'Sem acesso ao que a MAVI sabe desta pessoa.' using errcode = '42501';
 end if;
 select * into s from mavi_private.mavi_person_state where company_id = p_company and user_id = v_user;
 return jsonb_build_object(
  'user', v_user, 'self', v_user = auth.uid(),
  'items', mavi_private.mavi_person_items(p_company, v_user, true),
  'facts', mavi_private.mavi_person_facts(p_company, v_user),
  'history', (select jsonb_build_object('up', count(*) filter (where f.vote = 'up'),
     'down', count(*) filter (where f.vote = 'down'),
     'reasons', (select coalesce(jsonb_object_agg(r.reason, r.n), '{}') from (select g.reason, count(*)::int n
       from public.mavi_feedback g where g.company_id = p_company and g.user_id = v_user and g.reason is not null
       group by g.reason) r),
     'recent', (select coalesce(jsonb_agg(jsonb_build_object('vote', x.vote, 'reason', x.reason, 'comment', x.comment,
        'question', left(x.question, 200), 'at', x.updated_at) order by x.updated_at desc), '[]')
       from (select * from public.mavi_feedback g where g.company_id = p_company and g.user_id = v_user
        order by g.updated_at desc limit 6) x))
   from public.mavi_feedback f where f.company_id = p_company and f.user_id = v_user),
  'log', (select coalesce(jsonb_agg(jsonb_build_object('action', l.action, 'kind', l.kind, 'before', l.text_before,
     'after', l.text_after, 'actor', l.actor, 'by', l.by, 'at', l.at) order by l.at desc, l.id desc), '[]')
   from (select * from public.mavi_person_trait_log g where g.company_id = p_company and g.user_id = v_user
    order by g.at desc, g.id desc limit 40) l),
  'valid_days', extract(day from mavi_private.mavi_person_valid_for())::int,
  'built_at', s.built_at, 'pending', s.dirty_at is not null,
  'can_edit', true);
end $$;

-- Em cada pergunta: o que vale (sem os vencidos), com o id (o chip da resposta).
create or replace function public.mavi_person_context(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return jsonb_build_object(
  'items', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'text', t.text,
     'durability', t.durability) order by t.kind, t.pinned desc, t.updated_at desc), '[]')
   from (select * from public.mavi_person_traits x where x.company_id = p_company and x.user_id = auth.uid()
    and not x.dismissed and (x.valid_until is null or x.valid_until >= now())
    order by x.pinned desc, x.updated_at desc limit 20) t),
  'facts', mavi_private.mavi_person_facts(p_company, auth.uid()));
end $$;

create or replace function public.mavi_judge_person(p_secret text, p_message bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.ai_conversations; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select v.* into c from public.ai_messages m join public.ai_conversations v on v.id = m.conversation_id
 where m.id = p_message;
 if c.id is null then return '[]'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'text', t.text)), '[]')
  from (select * from public.mavi_person_traits x where x.company_id = c.company_id and x.user_id = c.owner_id
   and not x.dismissed and (x.valid_until is null or x.valid_until >= now())
   order by x.pinned desc, x.updated_at desc limit 20) t);
end $$;

-- ------------------------------------------------------------ na tela
-- Escrever ou corrigir: fica fixado. Situação vale 60 dias (corrigir renova).
drop function public.mavi_person_trait_save(uuid, uuid, uuid, text, text);
create function public.mavi_person_trait_save(p_company uuid, p_user uuid, p_id uuid, p_kind text, p_text text,
 p_durability text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_user uuid := coalesce(p_user, auth.uid());
 v_origin text := case when v_user = auth.uid() then 'person' else 'leader' end;
 v_dur text := case when p_durability in ('stable', 'situation') then p_durability end; begin
 if not mavi_private.mavi_person_viewer(p_company, v_user) then
  raise exception 'Sem acesso ao que a MAVI sabe desta pessoa.' using errcode = '42501';
 end if;
 if coalesce(p_kind, '') not in ('preference', 'context', 'frustration') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if length(btrim(coalesce(p_text, ''))) not between 3 and 300 then
  raise exception 'Escreva de 3 a 300 caracteres.' using errcode = '22023';
 end if;
 if p_id is null then
  if (select count(*) from public.mavi_person_traits t where t.company_id = p_company and t.user_id = v_user
   and not t.dismissed) >= 40 then
   raise exception 'No máximo 40 itens por pessoa: remova algum antes.' using errcode = '22023';
  end if;
  v_dur := coalesce(v_dur, 'stable');
  insert into public.mavi_person_traits(company_id, user_id, kind, text, origin, pinned, updated_by, durability, valid_until)
  values (p_company, v_user, p_kind, btrim(p_text), v_origin, true, auth.uid(), v_dur,
   case when v_dur = 'situation' then now() + mavi_private.mavi_person_valid_for() end) returning id into v_id;
 else
  update public.mavi_person_traits t set kind = p_kind, text = btrim(p_text), origin = v_origin, pinned = true,
   dismissed = false, updated_at = now(), updated_by = auth.uid(),
   durability = coalesce(v_dur, t.durability),
   valid_until = case when coalesce(v_dur, t.durability) = 'situation' then now() + mavi_private.mavi_person_valid_for() end
  where id = p_id and company_id = p_company and user_id = v_user returning id into v_id;
  if v_id is null then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 end if;
 return v_id;
end $$;

-- Fixar, soltar, remover, trazer de volta ou renovar (situação: mais 60 dias).
create or replace function public.mavi_person_trait_set(p_company uuid, p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; begin
 select t.user_id into v_user from public.mavi_person_traits t where t.id = p_id and t.company_id = p_company;
 if v_user is null or not mavi_private.mavi_person_viewer(p_company, v_user) then
  raise exception 'Item não encontrado.' using errcode = 'P0002';
 end if;
 if p_action not in ('pin', 'unpin', 'dismiss', 'restore', 'renew') then
  raise exception 'Ação inválida.' using errcode = '22023';
 end if;
 update public.mavi_person_traits set
  pinned = case p_action when 'pin' then true when 'unpin' then false else pinned end,
  dismissed = case p_action when 'dismiss' then true when 'restore' then false else dismissed end,
  valid_until = case when p_action = 'renew' and durability = 'situation'
   then now() + mavi_private.mavi_person_valid_for() else valid_until end,
  updated_at = now(), updated_by = auth.uid()
 where id = p_id;
end $$;

-- ------------------------------------------------------------ na conversa
-- A MAVI anota o que a pessoa disse com todas as letras: add (um item novo),
-- replace (corrige um item: o antigo sai) ou forget (o item deixou de valer).
-- Nasce como da pessoa e fixado (a rotina não mexe); o histórico registra
-- que foi a MAVI, e a fonte é a conversa.
create function public.mavi_person_note(p_company uuid, p_op text, p_id uuid, p_kind text, p_text text,
 p_durability text, p_conversation uuid, p_said text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); t public.mavi_person_traits; v_id uuid; v_text text := btrim(coalesce(p_text, ''));
 v_dur text := case when p_durability = 'situation' then 'situation' else 'stable' end; v_conv uuid; v_src jsonb; begin
 if v_user is null or not mavi_private.member(p_company) then
  raise exception 'Sem acesso ao espaço' using errcode = '42501';
 end if;
 if coalesce(p_op, '') not in ('add', 'replace', 'forget') then
  raise exception 'Ação inválida.' using errcode = '22023';
 end if;
 if p_op <> 'forget' and (select count(*) from public.mavi_person_trait_log l where l.company_id = p_company
  and l.user_id = v_user and l.by = v_user and l.actor = 'mavi' and l.action in ('add', 'edit', 'restore')
  and l.at > now() - interval '1 hour') >= 6 then
  raise exception 'A MAVI já anotou bastante nesta hora: o resto fica para depois.' using errcode = '22023';
 end if;
 perform set_config('mavi.person_actor', 'mavi', true);
 if p_op in ('replace', 'forget') then
  select x.* into t from public.mavi_person_traits x where x.id = p_id and x.company_id = p_company and x.user_id = v_user;
  if t.id is null then raise exception 'Item da memória não encontrado.' using errcode = 'P0002'; end if;
  if not t.dismissed then
   update public.mavi_person_traits set dismissed = true, updated_at = now(), updated_by = v_user where id = t.id;
  end if;
  if p_op = 'forget' then
   perform set_config('mavi.person_actor', '', true);
   return jsonb_build_object('op', 'forget', 'id', t.id, 'kind', t.kind, 'text', t.text, 'durability', t.durability);
  end if;
 end if;
 if coalesce(p_kind, '') not in ('preference', 'context', 'frustration') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if length(v_text) not between 3 and 300 then
  raise exception 'Escreva de 3 a 300 caracteres.' using errcode = '22023';
 end if;
 select v.id into v_conv from public.ai_conversations v
 where v.id = p_conversation and v.company_id = p_company and v.owner_id = v_user;
 v_src := jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('type', 'chat', 'conversation', v_conv,
  'said', nullif(left(btrim(coalesce(p_said, '')), 300), ''), 'at', now())));
 -- O mesmo texto já existe: volta a valer (a pessoa disse de novo).
 select x.id into v_id from public.mavi_person_traits x where x.company_id = p_company and x.user_id = v_user
  and lower(x.text) = lower(v_text) and x.id is distinct from t.id limit 1;
 if v_id is not null then
  update public.mavi_person_traits x set dismissed = false, pinned = true, kind = p_kind, durability = v_dur,
   valid_until = case when v_dur = 'situation' then now() + mavi_private.mavi_person_valid_for() end,
   sources = mavi_private.mavi_person_merge_sources(v_src, x.sources), updated_at = now(), updated_by = v_user
  where x.id = v_id;
 else
  if (select count(*) from public.mavi_person_traits x where x.company_id = p_company and x.user_id = v_user
   and not x.dismissed) >= 40 then
   raise exception 'A memória já tem 40 itens: peça para remover algum antes.' using errcode = '22023';
  end if;
  insert into public.mavi_person_traits(company_id, user_id, kind, text, origin, pinned, updated_by, durability,
   valid_until, sources)
  values (p_company, v_user, p_kind, v_text, 'person', true, v_user, v_dur,
   case when v_dur = 'situation' then now() + mavi_private.mavi_person_valid_for() end, v_src)
  returning id into v_id;
 end if;
 perform set_config('mavi.person_actor', '', true);
 return jsonb_build_object('op', p_op, 'id', v_id, 'kind', p_kind, 'text', v_text, 'durability', v_dur,
  'previous', case when p_op = 'replace' then t.text end, 'previous_id', case when p_op = 'replace' then t.id end);
end $$;

-- ------------------------------------------------------------ worker
-- Com os ids (a MAVI diz de onde veio cada item) e os vencidos marcados.
create or replace function public.mavi_person_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.mavi_person_state; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select x.* into s from mavi_private.mavi_person_state x
 where (x.company_id, x.user_id) in (select d.company_id, d.user_id from mavi_private.mavi_person_due() d)
 order by x.urgent desc, x.dirty_at limit 1 for update skip locked;
 if s.company_id is null then return null; end if;
 update mavi_private.mavi_person_state set claimed_at = now(), running_until = now() + interval '4 minutes'
 where company_id = s.company_id and user_id = s.user_id;
 return jsonb_build_object('company', s.company_id, 'user', s.user_id,
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

-- As fontes que a rotina manda: só objetos dos tipos conhecidos, até 6.
create function mavi_private.mavi_person_sources(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
 select coalesce(jsonb_agg(x.s), '[]') from (
  select s from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]' end) s
  where jsonb_typeof(s) = 'object' and s->>'type' in ('feedback', 'check', 'question')
  limit 6) x
$$;

-- As fontes novas na frente das antigas, até 8.
create function mavi_private.mavi_person_merge_sources(p_new jsonb, p_old jsonb) returns jsonb
language sql immutable set search_path = '' as $$
 select coalesce(jsonb_agg(x.s order by x.i), '[]') from (
  select s, i from jsonb_array_elements(coalesce(p_new, '[]') || coalesce(p_old, '[]')) with ordinality e(s, i)
  order by i limit 8) x
$$;

-- As mudanças: add {kind, text, durability, sources} · update {id, text, kind,
-- durability, sources} (num item de situação, renova) · retire {id}. Só nos
-- itens da MAVI que ninguém fixou nem removeu; sem repetir o que já existe
-- (removido também); no máximo 15 itens da MAVI por pessoa.
create or replace function public.mavi_person_store(p_secret text, p_company uuid, p_user uuid, p_ops jsonb, p_usage jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare o jsonb; v_changed integer := 0; v_text text; v_kind text; v_dur text; v_id uuid; v_n integer; v_src jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_text := btrim(coalesce(o->>'text', ''));
  v_kind := case when o->>'kind' in ('preference', 'context', 'frustration') then o->>'kind' end;
  v_dur := case when o->>'durability' in ('stable', 'situation') then o->>'durability' end;
  v_id := case when o->>'id' ~* '^[0-9a-f-]{36}$' then (o->>'id')::uuid end;
  v_src := mavi_private.mavi_person_sources(o->'sources');
  if o->>'op' = 'add' then
   continue when v_kind is null or length(v_text) not between 3 and 300;
   continue when exists (select 1 from public.mavi_person_traits t where t.company_id = p_company
    and t.user_id = p_user and lower(t.text) = lower(v_text));
   continue when (select count(*) from public.mavi_person_traits t where t.company_id = p_company
    and t.user_id = p_user and t.origin = 'mavi' and not t.dismissed) >= 15;
   v_dur := coalesce(v_dur, 'stable');
   insert into public.mavi_person_traits(company_id, user_id, kind, text, origin, durability, valid_until, sources)
   values (p_company, p_user, v_kind, v_text, 'mavi', v_dur,
    case when v_dur = 'situation' then now() + mavi_private.mavi_person_valid_for() end, v_src);
   v_changed := v_changed + 1;
  elsif o->>'op' = 'update' and v_id is not null then
   update public.mavi_person_traits t set text = case when length(v_text) between 3 and 300 then v_text else t.text end,
    kind = coalesce(v_kind, t.kind), durability = coalesce(v_dur, t.durability),
    valid_until = case when coalesce(v_dur, t.durability) = 'situation'
     then now() + mavi_private.mavi_person_valid_for() end,
    sources = mavi_private.mavi_person_merge_sources(v_src, t.sources),
    updated_at = now(), updated_by = null
   where t.id = v_id and t.company_id = p_company and t.user_id = p_user and t.origin = 'mavi'
    and not t.pinned and not t.dismissed;
   get diagnostics v_n = row_count; v_changed := v_changed + v_n;
  elsif o->>'op' = 'retire' and v_id is not null then
   delete from public.mavi_person_traits t
   where t.id = v_id and t.company_id = p_company and t.user_id = p_user and t.origin = 'mavi'
    and not t.pinned and not t.dismissed;
   get diagnostics v_n = row_count; v_changed := v_changed + v_n;
  end if;
 end loop;
 update mavi_private.mavi_person_state s set built_at = now(), running_until = null, attempts = 0, last_error = null,
  urgent = false, dirty_at = case when s.dirty_at > s.claimed_at then s.dirty_at end
 where s.company_id = p_company and s.user_id = p_user;
 if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (p_company, null, 'mavi', 'profile', left(coalesce(p_usage->>'model', ''), 80),
   greatest(coalesce((p_usage->>'input')::integer, 0), 0), greatest(coalesce((p_usage->>'output')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_read')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100),
   case when p_usage->>'provider_id' ~* '^[0-9a-f-]{36}$' then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 return v_changed;
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.mavi_person_valid_for(), mavi_private.mavi_person_trait_logger(),
 mavi_private.mavi_person_sources(jsonb), mavi_private.mavi_person_merge_sources(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.mavi_person_used(bigint, uuid[]), public.mavi_person_lookup(uuid, uuid[]),
 public.mavi_person_trait_save(uuid, uuid, uuid, text, text, text),
 public.mavi_person_note(uuid, text, uuid, text, text, text, uuid, text) from public, anon;
grant execute on function public.mavi_person_used(bigint, uuid[]), public.mavi_person_lookup(uuid, uuid[]),
 public.mavi_person_trait_save(uuid, uuid, uuid, text, text, text),
 public.mavi_person_note(uuid, text, uuid, text, text, text, uuid, text) to authenticated;

commit;
