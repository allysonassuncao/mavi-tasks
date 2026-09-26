begin;

-- IA do MAVI · fase 2: conversas salvas e compartilháveis, limites de gasto
-- e relatório de consumo.
--
-- Conversas: cada pessoa vê as próprias e as compartilhadas com ela. Só quem
-- criou continua a conversa, renomeia, apaga e compartilha. Compartilhar só
-- vale para quem já veria todas as fontes citadas na conversa (reuniões pela
-- regra do Drive, tarefas pela visibilidade de tarefas): ninguém vê pelo
-- compartilhamento o que não veria no sistema. Quem recebe ganha um aviso na
-- caixa de entrada.
--
-- Limites: por mês (calendário de Brasília), para a empresa, uma pessoa, um
-- cliente, um produto contratado ou um projeto. A IA confere antes de chamar
-- o modelo; o painel de consumo (líderes) mostra o gasto e define limites.

-- ------------------------------------------------------------ conversas
create table public.ai_conversations (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 owner_id uuid not null default auth.uid(),
 title text not null default 'Nova conversa' check (length(btrim(title)) between 1 and 200),
 scope jsonb not null default '{}' check (jsonb_typeof(scope) = 'object'),
 module text not null default 'assistant' check (length(module) <= 40),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(company_id, id),
 foreign key(company_id, owner_id) references public.memberships(company_id, user_id)
);
create index ai_conversations_owner on public.ai_conversations(company_id, owner_id, updated_at desc);

create table public.ai_messages (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 conversation_id uuid not null,
 role text not null check (role in ('user', 'assistant')),
 content text not null check (length(content) <= 40000),
 sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'),
 steps jsonb not null default '[]' check (jsonb_typeof(steps) = 'array'),
 created_at timestamptz not null default now(),
 foreign key(company_id, conversation_id) references public.ai_conversations(company_id, id) on delete cascade
);
create index ai_messages_conversation on public.ai_messages(conversation_id, id);

create table public.ai_conversation_shares (
 company_id uuid not null,
 conversation_id uuid not null,
 user_id uuid not null,
 shared_by uuid not null default auth.uid(),
 shared_at timestamptz not null default now(),
 primary key (conversation_id, user_id),
 foreign key(company_id, conversation_id) references public.ai_conversations(company_id, id) on delete cascade,
 foreign key(company_id, user_id) references public.memberships(company_id, user_id)
);
create index ai_conversation_shares_user on public.ai_conversation_shares(company_id, user_id);

alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_conversation_shares enable row level security;
revoke all on public.ai_conversations, public.ai_messages, public.ai_conversation_shares from public, anon, authenticated;
grant select on public.ai_conversations, public.ai_messages, public.ai_conversation_shares to authenticated;

create function mavi_private.ai_conversation_visible(c uuid, p_conversation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(c) and (
  exists (select 1 from public.ai_conversations v where v.company_id = c and v.id = p_conversation and v.owner_id = auth.uid())
  or exists (select 1 from public.ai_conversation_shares s where s.company_id = c and s.conversation_id = p_conversation
   and s.user_id = auth.uid()))
$$;
revoke all on function mavi_private.ai_conversation_visible(uuid, uuid) from public, anon;
grant execute on function mavi_private.ai_conversation_visible(uuid, uuid) to authenticated;

create policy ai_conversations_read on public.ai_conversations for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.ai_conversation_visible(company_id, id));
create policy ai_messages_read on public.ai_messages for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.ai_conversation_visible(company_id, conversation_id));
create policy ai_conversation_shares_read on public.ai_conversation_shares for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.ai_conversation_visible(company_id, conversation_id));

-- O que outra pessoa (não quem está logado) vê: as mesmas regras do Drive e
-- das tarefas, para conferir um compartilhamento.
create function mavi_private.ai_user_sees_client(c uuid, u uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.memberships m where m.company_id = c and m.user_id = u and m.active
  and (m.role in ('admin', 'manager') or p_client is null or exists (
   select 1 from public.client_teams ct join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
   where ct.company_id = c and ct.client_id = p_client and tm.user_id = u)))
$$;
create function mavi_private.ai_user_sees_task(c uuid, u uuid, t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.memberships m where m.company_id = c and m.user_id = u and m.active)
 and exists (select 1 from public.tasks tk
  join public.contracts k on k.company_id = tk.company_id and k.id = tk.contract_id
  join public.memberships m on m.company_id = tk.company_id and m.user_id = u and m.active
  where tk.company_id = c and tk.id = t and (
   m.role in ('admin', 'manager') or tk.creator_id = u or tk.assignee_id = u
   or exists (select 1 from public.task_participants p where p.company_id = c and p.task_id = t and p.user_id = u)
   or exists (select 1 from public.team_members tm where tm.company_id = c and tm.user_id = u and tm.supervisor and (
    tm.team_id = tk.team_id or (tk.team_id is null and exists (select 1 from public.client_teams ct
     where ct.company_id = c and ct.client_id = k.client_id and ct.team_id = tm.team_id))))))
$$;
revoke all on function mavi_private.ai_user_sees_client(uuid, uuid, uuid), mavi_private.ai_user_sees_task(uuid, uuid, uuid)
 from public, anon, authenticated;

-- Grava uma pergunta e a resposta (abre a conversa na primeira).
create function public.ai_save_turn(p_company uuid, p_conversation uuid, p_scope jsonb, p_module text,
 p_question text, p_answer text, p_sources jsonb, p_steps jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := p_conversation; v_owner uuid; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if v_id is null then
  insert into public.ai_conversations(company_id, title, scope, module)
  values (p_company, left(coalesce(nullif(btrim(regexp_replace(p_question, '\s+', ' ', 'g')), ''), 'Nova conversa'), 80),
   coalesce(p_scope, '{}'), left(coalesce(p_module, 'assistant'), 40))
  returning id into v_id;
 else
  select owner_id into v_owner from public.ai_conversations where company_id = p_company and id = v_id;
  if v_owner is null then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
  if v_owner <> auth.uid() then
   raise exception 'Só quem começou a conversa continua nela.' using errcode = '42501';
  end if;
  update public.ai_conversations set updated_at = now() where id = v_id;
 end if;
 insert into public.ai_messages(company_id, conversation_id, role, content) values (p_company, v_id, 'user', left(p_question, 40000));
 insert into public.ai_messages(company_id, conversation_id, role, content, sources, steps)
 values (p_company, v_id, 'assistant', left(p_answer, 40000), coalesce(p_sources, '[]'), coalesce(p_steps, '[]'));
 return v_id;
end $$;

create function public.ai_rename_conversation(p_conversation uuid, p_title text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 update public.ai_conversations set title = left(btrim(p_title), 200)
 where id = p_conversation and owner_id = auth.uid() and mavi_private.member(company_id);
 if not found then raise exception 'Só quem começou a conversa muda o nome.' using errcode = '42501'; end if;
end $$;
create function public.ai_delete_conversation(p_conversation uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 delete from public.ai_conversations where id = p_conversation and owner_id = auth.uid() and mavi_private.member(company_id);
 if not found then raise exception 'Só quem começou a conversa apaga.' using errcode = '42501'; end if;
end $$;

-- Compartilha com estas pessoas (substitui a lista). Quem não veria todas as
-- fontes citadas fica de fora, com o motivo.
create function public.ai_share_conversation(p_conversation uuid, p_users uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.ai_conversations; u uuid; s jsonb; refused jsonb := '[]'; shared uuid[] := '{}'; ok boolean; v_name text; begin
 select * into v from public.ai_conversations where id = p_conversation;
 if not found or v.owner_id <> auth.uid() or not mavi_private.member(v.company_id) then
  raise exception 'Só quem começou a conversa compartilha.' using errcode = '42501';
 end if;
 for u in select distinct x from unnest(coalesce(p_users, '{}')) x where x <> v.owner_id loop
  ok := exists (select 1 from public.memberships m where m.company_id = v.company_id and m.user_id = u and m.active);
  if ok then
   for s in select jsonb_array_elements(m.sources) from public.ai_messages m where m.conversation_id = v.id loop
    if (s->>'type' = 'task' and not mavi_private.ai_user_sees_task(v.company_id, u, (s->>'id')::uuid))
     or (s->>'type' <> 'task' and not mavi_private.ai_user_sees_client(v.company_id, u, nullif(s->>'client_id', '')::uuid)) then
     ok := false; exit;
    end if;
   end loop;
   if not ok then
    refused := refused || jsonb_build_object('user', u, 'reason', 'não tem acesso a alguma fonte citada');
   else
    shared := shared || u;
   end if;
  else
   refused := refused || jsonb_build_object('user', u, 'reason', 'não está ativo na empresa');
  end if;
 end loop;
 delete from public.ai_conversation_shares where conversation_id = v.id and not (user_id = any(shared));
 select name into v_name from public.memberships where company_id = v.company_id and user_id = auth.uid();
 with added as (
  insert into public.ai_conversation_shares(company_id, conversation_id, user_id)
  select v.company_id, v.id, x from unnest(shared) x
  on conflict do nothing
  returning user_id)
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 select v.company_id, a.user_id, auth.uid(), null, 'ai_share',
  format('%s compartilhou uma conversa da IA', coalesce(v_name, 'Alguém')), v.title,
  '/visao-geral?conversa=' || v.id
 from added a;
 return jsonb_build_object('shared', to_jsonb(shared), 'refused', refused);
end $$;
revoke all on function public.ai_save_turn(uuid, uuid, jsonb, text, text, text, jsonb, jsonb),
 public.ai_rename_conversation(uuid, text), public.ai_delete_conversation(uuid),
 public.ai_share_conversation(uuid, uuid[]) from public, anon;
grant execute on function public.ai_save_turn(uuid, uuid, jsonb, text, text, text, jsonb, jsonb),
 public.ai_rename_conversation(uuid, text), public.ai_delete_conversation(uuid),
 public.ai_share_conversation(uuid, uuid[]) to authenticated;

-- Avisos da caixa de entrada: conversa compartilhada.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share')) = (task_id is null) and (task_id is not null or (title is not null and link is not null)));

-- ------------------------------------------------------------ limites
create table public.ai_limits (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 scope_type text not null check (scope_type in ('company', 'user', 'client', 'contract', 'project')),
 scope_id uuid,
 monthly_usd numeric(12,2) not null check (monthly_usd > 0 and monthly_usd <= 100000),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 check ((scope_type = 'company') = (scope_id is null)),
 unique nulls not distinct (company_id, scope_type, scope_id)
);
alter table public.ai_limits enable row level security;
revoke all on public.ai_limits from public, anon, authenticated;
grant select on public.ai_limits to authenticated;
create policy ai_limits_read on public.ai_limits for select to authenticated
 using (company_id in (select mavi_private.leader_companies()));

create index ai_usage_client on public.ai_usage(company_id, client_id, created_at desc) where client_id is not null;
create index ai_usage_contract on public.ai_usage(company_id, contract_id, created_at desc) where contract_id is not null;
create index ai_usage_project on public.ai_usage(company_id, project_id, created_at desc) where project_id is not null;

create function public.ai_set_limit(p_company uuid, p_type text, p_id uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores definem limites.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project') then raise exception 'Tipo inválido.'; end if;
 if p_amount is null or p_amount <= 0 then
  delete from public.ai_limits where company_id = p_company and scope_type = p_type and scope_id is not distinct from p_id;
  return;
 end if;
 insert into public.ai_limits(company_id, scope_type, scope_id, monthly_usd)
 values (p_company, p_type, case when p_type = 'company' then null else p_id end, round(p_amount, 2))
 on conflict (company_id, scope_type, scope_id) do update set monthly_usd = excluded.monthly_usd,
  updated_by = auth.uid(), updated_at = now();
end $$;

-- Início do mês corrente em Brasília.
create function mavi_private.ai_month_start() returns timestamptz
language sql stable set search_path = '' as $$
 select (date_trunc('month', now() at time zone 'America/Sao_Paulo')) at time zone 'America/Sao_Paulo'
$$;

-- Pode perguntar? Confere os limites que valem para esta pergunta (empresa,
-- pessoa, cliente, produto, projeto). Avisa a partir de 80%.
create function public.ai_check_limits(p_company uuid, p_client uuid, p_contract uuid, p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare l public.ai_limits; v_spent numeric; v_label text; v_start timestamptz := mavi_private.ai_month_start();
 blocked text; warnings jsonb := '[]'; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 for l in select * from public.ai_limits a where a.company_id = p_company and (
   a.scope_type = 'company'
   or (a.scope_type = 'user' and a.scope_id = auth.uid())
   or (a.scope_type = 'client' and a.scope_id = p_client)
   or (a.scope_type = 'contract' and a.scope_id = p_contract)
   or (a.scope_type = 'project' and a.scope_id = p_project))
 loop
  select coalesce(sum(u.cost_usd), 0) into v_spent from public.ai_usage u
  where u.company_id = p_company and u.created_at >= v_start and case l.scope_type
   when 'company' then true
   when 'user' then u.user_id = l.scope_id
   when 'client' then u.client_id = l.scope_id
   when 'contract' then u.contract_id = l.scope_id
   else u.project_id = l.scope_id end;
  v_label := case l.scope_type when 'company' then 'da empresa' when 'user' then 'seu'
   when 'client' then 'deste cliente' when 'contract' then 'deste produto' else 'deste projeto' end;
  if v_spent >= l.monthly_usd then
   blocked := coalesce(blocked, format('O limite mensal de IA %s (US$ %s) foi atingido. Fale com um administrador ou gestor.',
    v_label, replace(to_char(l.monthly_usd, 'FM999990.00'), '.', ',')));
  elsif v_spent >= l.monthly_usd * 0.8 then
   warnings := warnings || to_jsonb(format('O uso de IA %s está em %s%% do limite do mês.', v_label,
    round(v_spent / l.monthly_usd * 100)));
  end if;
 end loop;
 return jsonb_build_object('blocked', blocked is not null, 'message', blocked, 'warnings', warnings);
end $$;

-- Painel de consumo (líderes): totais e divisões no período, com os limites
-- e o gasto do mês de cada um.
create function public.ai_usage_report(p_company uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz; v_to timestamptz; v_start timestamptz := mavi_private.ai_month_start(); begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 v_from := p_from::timestamp at time zone 'America/Sao_Paulo';
 v_to := (p_to + 1)::timestamp at time zone 'America/Sao_Paulo';
 return (with u as (
   select * from public.ai_usage where company_id = p_company and created_at >= v_from and created_at < v_to)
  select jsonb_build_object(
   'total', (select jsonb_build_object('cost', coalesce(sum(cost_usd), 0),
     'asks', count(*) filter (where kind = 'ask'),
     'index_cost', coalesce(sum(cost_usd) filter (where kind = 'index'), 0),
     'input_tokens', coalesce(sum(input_tokens), 0), 'output_tokens', coalesce(sum(output_tokens), 0),
     'embedding_tokens', coalesce(sum(embedding_tokens), 0)) from u),
   'by_user', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select user_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where user_id is not null group by user_id) x),
   'by_client', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select client_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where client_id is not null group by client_id) x),
   'by_contract', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select contract_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where contract_id is not null group by contract_id) x),
   'by_project', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select project_id as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u where project_id is not null group by project_id) x),
   'by_module', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
     select module as id, sum(cost_usd) as cost, count(*) filter (where kind = 'ask') as asks
     from u group by module) x),
   'by_day', (select coalesce(jsonb_agg(x order by x.day), '[]') from (
     select to_char(created_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') as day, sum(cost_usd) as cost,
      count(*) filter (where kind = 'ask') as asks
     from u group by 1) x),
   'limits', (select coalesce(jsonb_agg(jsonb_build_object('type', l.scope_type, 'id', l.scope_id,
      'monthly_usd', l.monthly_usd, 'month_spent', (
       select coalesce(sum(a.cost_usd), 0) from public.ai_usage a
       where a.company_id = p_company and a.created_at >= v_start and case l.scope_type
        when 'company' then true when 'user' then a.user_id = l.scope_id when 'client' then a.client_id = l.scope_id
        when 'contract' then a.contract_id = l.scope_id else a.project_id = l.scope_id end))
      order by l.scope_type), '[]') from public.ai_limits l where l.company_id = p_company)));
end $$;
revoke all on function public.ai_set_limit(uuid, text, uuid, numeric), public.ai_check_limits(uuid, uuid, uuid, uuid),
 public.ai_usage_report(uuid, date, date), mavi_private.ai_month_start() from public, anon;
grant execute on function public.ai_set_limit(uuid, text, uuid, numeric), public.ai_check_limits(uuid, uuid, uuid, uuid),
 public.ai_usage_report(uuid, date, date) to authenticated;

commit;
