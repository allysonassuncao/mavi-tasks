begin;

-- MAVI · base de comportamento por pessoa (Fase 4 do pedido de 30/09/2026):
--
-- 1. O que a MAVI sabe de cada pessoa, para responder do jeito dela
--    (mavi_person_traits): preferências de resposta (formato, tamanho, tom),
--    contexto de trabalho (clientes, produtos e assuntos em que atua, o que
--    costuma pedir) e padrões de frustração (o que evitar). Mais o que o
--    sistema já sabe sem modelo: o papel, as equipes, os clientes que ela
--    mais consulta com a MAVI e o histórico das avaliações dela.
-- 2. A MAVI mantém os itens sozinha (o worker do mesmo agendamento
--    "ai-learning", funcionalidade 'mavi_learning'), lendo as avaliações da
--    pessoa, as reclamações e os pedidos repetidos, e as perguntas recentes.
--    No máximo uma vez por dia (ou uma hora depois de um comentário novo).
-- 3. A própria pessoa e os administradores e gestores veem e editam (gestor
--    não vê administradores). O que alguém escreve, fixa ou remove, a MAVI
--    não muda nem recria.
-- 4. Em cada pergunta da pessoa, a MAVI recebe os itens dela; o juiz da
--    autoavaliação também, para conferir se a resposta respeitou o jeito dela.

create table public.mavi_person_traits (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 -- preference: como gosta das respostas · context: onde e com o que trabalha ·
 -- frustration: o que a frustra (o que evitar).
 kind text not null check (kind in ('preference', 'context', 'frustration')),
 text text not null check (length(btrim(text)) between 3 and 300),
 origin text not null check (origin in ('mavi', 'person', 'leader')),
 -- Fixado: a MAVI não muda. O que pessoas escrevem nasce fixado.
 pinned boolean not null default false,
 -- Removido: some e a MAVI não traz de volta.
 dismissed boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid
);
create index mavi_person_traits_user on public.mavi_person_traits (company_id, user_id);
alter table public.mavi_person_traits enable row level security;
revoke all on public.mavi_person_traits from public, anon, authenticated;

create table mavi_private.mavi_person_state (
 company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 dirty_at timestamptz,
 -- Um comentário novo nas avaliações: atualiza mais cedo (uma hora).
 urgent boolean not null default false,
 claimed_at timestamptz,
 running_until timestamptz,
 built_at timestamptz,
 attempts integer not null default 0,
 last_error text,
 primary key (company_id, user_id)
);
alter table mavi_private.mavi_person_state enable row level security;
revoke all on mavi_private.mavi_person_state from public, anon, authenticated;

create function mavi_private.mavi_person_dirty(c uuid, u uuid, p_urgent boolean) returns void
language sql security definer set search_path = '' as $$
 insert into mavi_private.mavi_person_state(company_id, user_id, dirty_at, urgent)
 select c, u, now(), coalesce(p_urgent, false) where u is not null
 on conflict (company_id, user_id) do update set
  -- Durante uma leitura, a marca nova fica (a leitura em curso não a viu).
  dirty_at = case when mavi_person_state.running_until > now() then now()
   else coalesce(mavi_person_state.dirty_at, now()) end,
  urgent = mavi_person_state.urgent or excluded.urgent
$$;

create function mavi_private.mavi_person_touch() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if tg_table_name = 'mavi_feedback' then
  if new.origin = 'person' then
   perform mavi_private.mavi_person_dirty(new.company_id, new.user_id, new.comment <> '');
  end if;
 elsif tg_table_name = 'mavi_answer_checks' then
  if new.signals && array['frustration', 'repeated']::text[] then
   perform mavi_private.mavi_person_dirty(new.company_id, new.user_id, false);
  end if;
 elsif tg_table_name = 'ai_conversations' then
  perform mavi_private.mavi_person_dirty(new.company_id, new.owner_id, false);
 end if;
 return null;
end $$;
create trigger mavi_person_from_feedback after insert or update of vote, reason, comment on public.mavi_feedback
 for each row execute function mavi_private.mavi_person_touch();
create trigger mavi_person_from_checks after insert or update of signals on public.mavi_answer_checks
 for each row execute function mavi_private.mavi_person_touch();
create trigger mavi_person_from_conversations after insert on public.ai_conversations
 for each row execute function mavi_private.mavi_person_touch();

-- Quem vê a base de uma pessoa: ela mesma, administradores e gestores
-- (gestor não vê administradores).
create function mavi_private.mavi_person_viewer(c uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(c) and exists (select 1 from public.memberships m where m.company_id = c and m.user_id = u)
  and (u = auth.uid() or mavi_private.admin(c)
   or (mavi_private.leader(c) and not exists (select 1 from public.memberships m
    where m.company_id = c and m.user_id = u and m.role = 'admin')))
$$;

-- O que o sistema sabe sem modelo: papel, equipes e os clientes que a pessoa
-- mais consulta com a MAVI (90 dias).
create function mavi_private.mavi_person_facts(c uuid, u uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'role', (select m.role from public.memberships m where m.company_id = c and m.user_id = u),
  'teams', (select coalesce(jsonb_agg(t.name order by t.name), '[]') from public.team_members tm
   join public.teams t on t.company_id = tm.company_id and t.id = tm.team_id
   where tm.company_id = c and tm.user_id = u),
  'clients', (select coalesce(jsonb_agg(jsonb_build_object('id', x.client_id, 'name', k.name, 'n', x.n) order by x.n desc), '[]')
   from (select a.client_id, count(*)::int as n from public.ai_usage a
    where a.company_id = c and a.user_id = u and a.client_id is not null and a.created_at > now() - interval '90 days'
     and a.kind in ('ask', 'task')
    group by a.client_id order by count(*) desc limit 6) x
   join public.clients k on k.company_id = c and k.id = x.client_id))
$$;

create function mavi_private.mavi_person_items(c uuid, u uuid, p_with_dismissed boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'text', t.text, 'origin', t.origin,
   'pinned', t.pinned, 'dismissed', t.dismissed, 'updated_at', t.updated_at, 'updated_by', t.updated_by)
  order by t.kind, t.pinned desc, t.updated_at desc), '[]')
 from public.mavi_person_traits t
 where t.company_id = c and t.user_id = u and (p_with_dismissed or not t.dismissed)
$$;

-- A tela: os itens, o que o sistema sabe e o histórico das avaliações.
create function public.mavi_person_profile(p_company uuid, p_user uuid) returns jsonb
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
  'built_at', s.built_at, 'pending', s.dirty_at is not null,
  'can_edit', true);
end $$;

-- Escrever ou corrigir um item: fica fixado (a MAVI não muda).
create function public.mavi_person_trait_save(p_company uuid, p_user uuid, p_id uuid, p_kind text, p_text text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_user uuid := coalesce(p_user, auth.uid());
 v_origin text := case when v_user = auth.uid() then 'person' else 'leader' end; begin
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
  insert into public.mavi_person_traits(company_id, user_id, kind, text, origin, pinned, updated_by)
  values (p_company, v_user, p_kind, btrim(p_text), v_origin, true, auth.uid()) returning id into v_id;
 else
  update public.mavi_person_traits set kind = p_kind, text = btrim(p_text), origin = v_origin, pinned = true,
   dismissed = false, updated_at = now(), updated_by = auth.uid()
  where id = p_id and company_id = p_company and user_id = v_user returning id into v_id;
  if v_id is null then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 end if;
 return v_id;
end $$;

-- Fixar, soltar, remover ou trazer de volta.
create function public.mavi_person_trait_set(p_company uuid, p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; begin
 select t.user_id into v_user from public.mavi_person_traits t where t.id = p_id and t.company_id = p_company;
 if v_user is null or not mavi_private.mavi_person_viewer(p_company, v_user) then
  raise exception 'Item não encontrado.' using errcode = 'P0002';
 end if;
 if p_action not in ('pin', 'unpin', 'dismiss', 'restore') then
  raise exception 'Ação inválida.' using errcode = '22023';
 end if;
 update public.mavi_person_traits set
  pinned = case p_action when 'pin' then true when 'unpin' then false else pinned end,
  dismissed = case p_action when 'dismiss' then true when 'restore' then false else dismissed end,
  updated_at = now(), updated_by = auth.uid()
 where id = p_id;
end $$;

-- Em cada pergunta: o que a MAVI sabe de quem pergunta.
create function public.mavi_person_context(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return jsonb_build_object(
  'items', (select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'text', t.text)
    order by t.kind, t.pinned desc, t.updated_at desc), '[]')
   from (select * from public.mavi_person_traits x where x.company_id = p_company and x.user_id = auth.uid()
    and not x.dismissed order by x.pinned desc, x.updated_at desc limit 20) t),
  'facts', mavi_private.mavi_person_facts(p_company, auth.uid()));
end $$;

-- ------------------------------------------------------------ worker
create function mavi_private.mavi_person_due() returns table(company_id uuid, user_id uuid)
language sql stable security definer set search_path = '' as $$
 select s.company_id, s.user_id from mavi_private.mavi_person_state s
 where s.dirty_at is not null and s.attempts < 5
  and (s.running_until is null or s.running_until < now())
  and s.dirty_at <= now() - interval '15 minutes'
  and (s.built_at is null or s.built_at < now() - interval '1 day'
   or (s.urgent and s.built_at < now() - interval '1 hour'))
$$;

-- Uma pessoa: as avaliações dela, as reclamações e os pedidos repetidos, as
-- perguntas recentes, o que o sistema sabe e os itens atuais.
create function public.mavi_person_claim(p_secret text) returns jsonb
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
  'feedback', (select coalesce(jsonb_agg(jsonb_build_object('vote', f.vote, 'reason', f.reason, 'comment', f.comment,
     'question', left(f.question, 300), 'answer', left(f.answer, 300), 'at', f.updated_at) order by f.updated_at desc), '[]')
   from (select * from public.mavi_feedback g where g.company_id = s.company_id and g.user_id = s.user_id
    order by g.updated_at desc limit 40) f),
  'frustrations', (select coalesce(jsonb_agg(jsonb_build_object('signals', to_jsonb(k.signals),
     'answer', left(m.content, 300),
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
    order by u.id desc limit 40) q));
end $$;

-- As mudanças: add {kind, text} · update {id, text, kind} · retire {id}. Só
-- nos itens da MAVI que ninguém fixou nem removeu; sem repetir o que já existe
-- (removido também); no máximo 15 itens da MAVI por pessoa.
create function public.mavi_person_store(p_secret text, p_company uuid, p_user uuid, p_ops jsonb, p_usage jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare o jsonb; v_changed integer := 0; v_text text; v_kind text; v_id uuid; v_n integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_text := btrim(coalesce(o->>'text', ''));
  v_kind := case when o->>'kind' in ('preference', 'context', 'frustration') then o->>'kind' end;
  v_id := case when o->>'id' ~* '^[0-9a-f-]{36}$' then (o->>'id')::uuid end;
  if o->>'op' = 'add' then
   continue when v_kind is null or length(v_text) not between 3 and 300;
   continue when exists (select 1 from public.mavi_person_traits t where t.company_id = p_company
    and t.user_id = p_user and lower(t.text) = lower(v_text));
   continue when (select count(*) from public.mavi_person_traits t where t.company_id = p_company
    and t.user_id = p_user and t.origin = 'mavi' and not t.dismissed) >= 15;
   insert into public.mavi_person_traits(company_id, user_id, kind, text, origin)
   values (p_company, p_user, v_kind, v_text, 'mavi');
   v_changed := v_changed + 1;
  elsif o->>'op' = 'update' and v_id is not null then
   update public.mavi_person_traits t set text = case when length(v_text) between 3 and 300 then v_text else t.text end,
    kind = coalesce(v_kind, t.kind), updated_at = now(), updated_by = null
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

create function public.mavi_person_fail(p_secret text, p_company uuid, p_user uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update mavi_private.mavi_person_state set attempts = attempts + 1, last_error = left(coalesce(p_error, ''), 500),
  running_until = now() + (attempts + 1) * interval '10 minutes'
 where company_id = p_company and user_id = p_user;
end $$;

-- O juiz da autoavaliação lê a base de quem perguntou.
create function public.mavi_judge_person(p_secret text, p_message bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.ai_conversations; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select v.* into c from public.ai_messages m join public.ai_conversations v on v.id = m.conversation_id
 where m.id = p_message;
 if c.id is null then return '[]'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'text', t.text)), '[]')
  from (select * from public.mavi_person_traits x where x.company_id = c.company_id and x.user_id = c.owner_id
   and not x.dismissed order by x.pinned desc, x.updated_at desc limit 20) t);
end $$;

-- O mesmo agendamento acorda também a base de comportamento.
create or replace function mavi_private.ai_learning_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.copilot_learning_due())
  and not exists (select 1 from mavi_private.mavi_learning_due())
  and not exists (select 1 from mavi_private.mavi_judge_due())
  and not exists (select 1 from mavi_private.mavi_person_due()) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-learning"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.mavi_person_dirty(uuid, uuid, boolean), mavi_private.mavi_person_touch(),
 mavi_private.mavi_person_viewer(uuid, uuid), mavi_private.mavi_person_facts(uuid, uuid),
 mavi_private.mavi_person_items(uuid, uuid, boolean), mavi_private.mavi_person_due()
 from public, anon, authenticated;
revoke all on function public.mavi_person_profile(uuid, uuid),
 public.mavi_person_trait_save(uuid, uuid, uuid, text, text), public.mavi_person_trait_set(uuid, uuid, text),
 public.mavi_person_context(uuid) from public, anon;
grant execute on function public.mavi_person_profile(uuid, uuid),
 public.mavi_person_trait_save(uuid, uuid, uuid, text, text), public.mavi_person_trait_set(uuid, uuid, text),
 public.mavi_person_context(uuid) to authenticated;
revoke all on function public.mavi_person_claim(text), public.mavi_person_store(text, uuid, uuid, jsonb, jsonb),
 public.mavi_person_fail(text, uuid, uuid, text), public.mavi_judge_person(text, bigint)
 from public, anon, authenticated;
grant execute on function public.mavi_person_claim(text), public.mavi_person_store(text, uuid, uuid, jsonb, jsonb),
 public.mavi_person_fail(text, uuid, uuid, text), public.mavi_judge_person(text, bigint) to anon, authenticated;

commit;
