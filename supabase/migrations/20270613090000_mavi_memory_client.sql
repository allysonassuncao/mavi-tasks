begin;

-- MAVI · memória por cliente, Fase 2 (pedido de 07/10/2026), sobre o dossiê
-- do cliente (20261101090000_task_copilot):
--
-- 1. Aprovação por risco, sem gargalo: a rotina do dossiê propõe mudanças; o
--    Jev confere cada uma contra o material citado e o próprio dossiê. O que
--    ele recusa nem chega a ninguém. Risco baixo/médio entra direto (com selo
--    "novo" na tela por 7 dias). Risco alto (regra ou combinado, condição
--    comercial, contradiz o dossiê, pouca evidência) vira sugestão
--    (client_dossier_proposals) que quem trabalha com o cliente confirma:
--    no Dossiê da MAVI ou no chat ("A MAVI notou… Confere?"). Sem resposta
--    em 14 dias, a sugestão é descartada (não passa a valer sozinha).
-- 2. Contestar: quem vê o dossiê marca um item como errado; ele sai na hora
--    (o copiloto, os Insights, o juiz e o chat param de usar) e fica com os
--    líderes, que restauram ou descartam.
-- 3. Na conversa: os itens ativos do dossiê entram no contexto do chat
--    quando a conversa é sobre o cliente; cada resposta guarda quais leu
--    (ai_messages.dossier, só os ids).

create table public.client_dossier_proposals (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 client_id uuid not null,
 -- add/update/remove: proposta da rotina · contest: um item contestado.
 op text not null check (op in ('add', 'update', 'remove', 'contest')),
 -- O item afetado (update, remove, contest). Sem chave estrangeira: o
 -- contestado sai do dossiê enquanto espera.
 item_id uuid,
 kind text not null check (kind in ('prefers', 'avoids', 'rule', 'style', 'context', 'history')),
 text text not null check (length(btrim(text)) between 3 and 600),
 -- O texto que o item tinha (update e contest).
 previous text,
 sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'),
 seen_at timestamptz,
 -- Por que pede confirmação (risco alto) ou por que o Jev recusou.
 reasons text[] not null default '{}',
 note text,
 -- As respostas do Jev (0 a 1), para medir.
 checks jsonb not null default '{}' check (jsonb_typeof(checks) = 'object'),
 -- O item inteiro, para restaurar um contestado.
 snapshot jsonb,
 -- suggested: aguarda confirmação · confirmed/refused: decidida por quem
 -- trabalha com o cliente · expired: 14 dias sem resposta · rejected: o Jev
 -- recusou · contested: aguarda um líder · restored/discarded: o líder decidiu.
 status text not null check (status in ('suggested', 'confirmed', 'refused', 'expired', 'rejected', 'contested',
  'restored', 'discarded')),
 contest_reason text check (length(contest_reason) <= 300),
 -- Quem já viu o cartão no chat (cada um vê uma vez).
 asked uuid[] not null default '{}',
 created_by uuid,
 created_at timestamptz not null default now(),
 expires_at timestamptz,
 decided_by uuid,
 decided_at timestamptz,
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
create index client_dossier_proposals_client on public.client_dossier_proposals (client_id, status, created_at desc);
alter table public.client_dossier_proposals enable row level security;
revoke all on public.client_dossier_proposals from public, anon, authenticated;

create function mavi_private.dossier_suggestion_days() returns interval
language sql immutable set search_path = '' as $$ select interval '14 days' $$;

-- As sugestões vencidas: descartadas (nunca passam a valer sozinhas).
create function mavi_private.dossier_expire(p_client uuid) returns void
language sql security definer set search_path = '' as $$
 update public.client_dossier_proposals set status = 'expired', decided_at = now()
 where client_id = p_client and status = 'suggested' and expires_at < now()
$$;

-- O mesmo texto (sem maiúsculas) não volta como sugestão: nem o que está
-- esperando, nem o que alguém recusou, descartou ou o Jev recusou (120 dias).
-- Sem p_rejected, o que o Jev recusou não bloqueia: com mais evidência, o
-- item pode entrar direto depois.
create function mavi_private.dossier_seen_text(p_client uuid, p_text text, p_rejected boolean) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.client_dossier_proposals p where p.client_id = p_client
  and lower(p.text) = lower(btrim(p_text))
  and (p.status in ('suggested', 'contested')
   or ((p.status in ('refused', 'discarded') or (p_rejected and p.status = 'rejected'))
    and p.created_at > now() - interval '120 days')))
$$;

-- ------------------------------------------------------------ leitura
create or replace function mavi_private.dossier_items_json(p_client uuid, p_with_dismissed boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'text', i.text, 'origin', i.origin,
   'pinned', i.pinned, 'dismissed', i.dismissed, 'sources', i.sources, 'seen_at', i.seen_at,
   'updated_at', i.updated_at, 'updated_by', i.updated_by, 'created_at', i.created_at)
  order by i.kind, i.pinned desc, i.seen_at desc nulls last, i.created_at), '[]')
 from public.client_dossier_items i
 where i.client_id = p_client and (p_with_dismissed or not i.dismissed)
$$;

create function mavi_private.dossier_proposals_json(p_client uuid, p_status text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'op', p.op, 'item_id', p.item_id, 'kind', p.kind,
   'text', p.text, 'previous', p.previous, 'sources', p.sources, 'seen_at', p.seen_at, 'reasons', to_jsonb(p.reasons),
   'note', p.note, 'status', p.status, 'contest_reason', p.contest_reason, 'created_by', p.created_by,
   'created_at', p.created_at, 'expires_at', p.expires_at) order by p.created_at desc), '[]')
 from (select * from public.client_dossier_proposals x where x.client_id = p_client and x.status = any(p_status)
  and (x.status <> 'suggested' or x.expires_at >= now()) order by x.created_at desc limit 40) p
$$;

-- A tela (Drive › cliente › Dossiê da MAVI): mais as sugestões para
-- confirmar (quem vê o dossiê) e os contestados (líderes).
create or replace function public.client_dossier(p_company uuid, p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.client_dossier_state; v_leader boolean := mavi_private.leader(p_company); begin
 if not mavi_private.dossier_reader(p_company, p_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 perform mavi_private.dossier_want(p_company, p_client);
 perform mavi_private.dossier_expire(p_client);
 select * into s from mavi_private.client_dossier_state where client_id = p_client;
 return jsonb_build_object('items', mavi_private.dossier_items_json(p_client, v_leader),
  'version', s.version, 'built_at', s.built_at, 'pending', s.dirty_at is not null,
  'failed', s.attempts >= 5, 'can_edit', v_leader, 'can_confirm', true,
  'proposals', mavi_private.dossier_proposals_json(p_client, array['suggested']),
  'contested', case when v_leader then mavi_private.dossier_proposals_json(p_client, array['contested']) else '[]' end);
end $$;

-- ------------------------------------------------------------ confirmar
-- Quem vê o dossiê confirma (a mudança vale) ou recusa (não volta).
create function public.client_dossier_decide(p_company uuid, p_proposal uuid, p_decision text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.client_dossier_proposals; v_n integer := 0; begin
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
  end if;
  get diagnostics v_n = row_count;
 end if;
 update public.client_dossier_proposals set status = case when p_decision = 'confirm' then 'confirmed' else 'refused' end,
  decided_by = auth.uid(), decided_at = now()
 where id = p.id;
 perform mavi_private.dossier_bump(p.client_id);
 return jsonb_build_object('id', p.id, 'status', case when p_decision = 'confirm' then 'confirmed' else 'refused' end);
end $$;

-- O estado das sugestões (o cartão do chat, depois de recarregar).
create function public.client_dossier_proposal_state(p_company uuid, p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', p.id,
   'status', case when p.status = 'suggested' and p.expires_at < now() then 'expired' else p.status end)), '[]')
  from public.client_dossier_proposals p
  where p.company_id = p_company and p.id = any(coalesce(p_ids[1:40], '{}'))
   and mavi_private.dossier_reader(p_company, p.client_id));
end $$;

-- ------------------------------------------------------------ contestar
-- Quem vê o dossiê diz que um item está errado: ele sai na hora (ninguém
-- mais usa) e fica com os líderes.
create function public.client_dossier_contest(p_company uuid, p_item uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare i public.client_dossier_items; v_id uuid; begin
 select * into i from public.client_dossier_items x where x.id = p_item and x.company_id = p_company for update;
 if i.id is null or i.dismissed or not mavi_private.dossier_reader(p_company, i.client_id) then
  raise exception 'Item não encontrado.' using errcode = 'P0002';
 end if;
 insert into public.client_dossier_proposals(company_id, client_id, op, item_id, kind, text, previous, sources, seen_at,
  snapshot, status, contest_reason, created_by)
 values (i.company_id, i.client_id, 'contest', i.id, i.kind, i.text, i.text, i.sources, i.seen_at, to_jsonb(i),
  'contested', nullif(left(btrim(coalesce(p_reason, '')), 300), ''), auth.uid())
 returning id into v_id;
 delete from public.client_dossier_items where id = i.id;
 perform mavi_private.dossier_bump(i.client_id);
 return v_id;
end $$;

-- Um líder decide o contestado: restore (volta como era) ou discard (sai; o
-- da MAVI fica como removido, para ela não trazer de volta).
create function public.client_dossier_resolve(p_company uuid, p_proposal uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.client_dossier_proposals; r public.client_dossier_items; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores decidem os contestados.' using errcode = '42501';
 end if;
 select * into p from public.client_dossier_proposals x where x.id = p_proposal and x.company_id = p_company for update;
 if p.id is null or p.status <> 'contested' then raise exception 'Contestação não encontrada.' using errcode = 'P0002'; end if;
 if coalesce(p_action, '') not in ('restore', 'discard') then
  raise exception 'Ação inválida.' using errcode = '22023';
 end if;
 r := jsonb_populate_record(null::public.client_dossier_items, p.snapshot);
 if p_action = 'restore' or r.origin = 'mavi' then
  if p_action = 'discard' then
   r.dismissed := true; r.pinned := false;
  end if;
  r.updated_by := auth.uid(); r.updated_at := now();
  insert into public.client_dossier_items select r.* on conflict (id) do nothing;
 end if;
 update public.client_dossier_proposals set status = case when p_action = 'restore' then 'restored' else 'discarded' end,
  decided_by = auth.uid(), decided_at = now()
 where id = p.id;
 perform mavi_private.dossier_bump(p.client_id);
end $$;

-- ------------------------------------------------------------ no chat
-- Os itens ativos do dossiê para o contexto da conversa sobre o cliente
-- (nada, sem acesso).
create function public.client_dossier_context(p_company uuid, p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.dossier_reader(p_company, p_client) then return null; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'text', i.text)
   order by i.pinned desc, i.seen_at desc nulls last), '[]')
  from (select * from public.client_dossier_items x where x.client_id = p_client and not x.dismissed
   order by x.pinned desc, x.seen_at desc nulls last limit 15) i);
end $$;

-- Uma sugestão para o cartão "A MAVI notou… Confere?" (cada pessoa vê uma
-- vez cada sugestão; a que vence primeiro vem antes).
create function public.client_dossier_ask(p_company uuid, p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.client_dossier_proposals; begin
 if auth.uid() is null or not mavi_private.dossier_reader(p_company, p_client) then return null; end if;
 select x.* into p from public.client_dossier_proposals x
 where x.company_id = p_company and x.client_id = p_client and x.status = 'suggested' and x.expires_at >= now()
  and not (auth.uid() = any(x.asked))
 order by x.expires_at limit 1 for update skip locked;
 if p.id is null then return null; end if;
 update public.client_dossier_proposals set asked = array_append(asked, auth.uid()) where id = p.id;
 return jsonb_build_object('id', p.id, 'op', p.op, 'kind', p.kind, 'text', p.text, 'previous', p.previous,
  'reasons', to_jsonb(p.reasons), 'sources', p.sources,
  'client', (select k.name from public.clients k where k.company_id = p_company and k.id = p_client));
end $$;

alter table public.ai_messages add column dossier jsonb not null default '[]' check (jsonb_typeof(dossier) = 'array');

-- A resposta guarda quais itens do dossiê ela leu.
create function public.mavi_dossier_used(p_message bigint, p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.ai_conversations; begin
 select v.* into c from public.ai_messages m join public.ai_conversations v on v.id = m.conversation_id
 where m.id = p_message and m.role = 'assistant';
 if c.id is null or c.owner_id is distinct from auth.uid() or not mavi_private.member(c.company_id) then
  raise exception 'Resposta não encontrada.' using errcode = 'P0002';
 end if;
 update public.ai_messages set dossier = (select coalesce(jsonb_agg(t.id), '[]') from (
   select x.id from public.client_dossier_items x where x.company_id = c.company_id
    and x.id = any(coalesce(p_ids, '{}')) and mavi_private.dossier_reader(c.company_id, x.client_id) limit 30) t)
 where id = p_message;
end $$;

-- Os itens do dossiê pelos ids (o chip da resposta): só para quem vê o dossiê.
create function public.client_dossier_lookup(p_company uuid, p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'client', i.client_id, 'kind', i.kind,
   'text', i.text, 'origin', i.origin, 'pinned', i.pinned, 'dismissed', i.dismissed)), '[]')
  from public.client_dossier_items i
  where i.company_id = p_company and i.id = any(coalesce(p_ids[1:40], '{}'))
   and mavi_private.dossier_reader(p_company, i.client_id));
end $$;

-- ------------------------------------------------------------ worker
-- O que a rotina não deve repetir: as sugestões esperando e as recusadas.
create function public.ai_dossier_proposals(p_secret text, p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform mavi_private.dossier_expire(p_client);
 return jsonb_build_object(
  'waiting', (select coalesce(jsonb_agg(p.text order by p.created_at desc), '[]') from (
    select x.text, x.created_at from public.client_dossier_proposals x where x.client_id = p_client
     and x.status in ('suggested', 'contested') order by x.created_at desc limit 30) p),
  'refused', (select coalesce(jsonb_agg(p.text order by p.created_at desc), '[]') from (
    select x.text, x.created_at from public.client_dossier_proposals x where x.client_id = p_client
     and x.status in ('refused', 'discarded', 'rejected') and x.created_at > now() - interval '120 days'
    order by x.created_at desc limit 30) p));
end $$;

-- Aplica as mudanças conferidas. Cada uma traz route: apply (entra direto,
-- como antes), suggest (risco alto: vira sugestão) ou refuse (o Jev
-- recusou: fica registrada, para medir e não voltar). Sem route: apply.
-- Itens fixados ou removidos por pessoas não mudam; no máximo 60 ativos.
create or replace function public.ai_dossier_store(p_secret text, p_client uuid, p_cursor_at timestamptz,
 p_cursor_id uuid, p_more boolean, p_ops jsonb, p_usage jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.client_dossier_state; o jsonb; v_changed integer := 0; v_n integer; v_kind text;
 v_text text; v_sources jsonb; v_seen timestamptz; v_id uuid; v_route text; v_item public.client_dossier_items;
 v_reasons text[]; v_checks jsonb; v_jev jsonb; begin
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
  if v_route <> 'apply' then
   -- A sugestão (ou a recusa) de mudar um item: o item precisa existir e ser da MAVI.
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
   continue when mavi_private.dossier_seen_text(p_client, v_text, true);
   insert into public.client_dossier_proposals(company_id, client_id, op, item_id, kind, text, previous, sources,
    seen_at, reasons, note, checks, status, expires_at)
   values (s.company_id, p_client, o->>'op', v_item.id, v_kind, v_text,
    case when o->>'op' = 'update' then v_item.text end, v_sources, v_seen, v_reasons,
    nullif(left(coalesce(o->>'note', ''), 500), ''), v_checks,
    case when v_route = 'suggest' then 'suggested' else 'rejected' end,
    case when v_route = 'suggest' then now() + mavi_private.dossier_suggestion_days() end);
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
  -- Ainda há material: volta logo. Chegou material durante a leitura: fica pendente.
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
  -- A conferência do Jev, à parte.
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

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.dossier_suggestion_days(), mavi_private.dossier_expire(uuid),
 mavi_private.dossier_seen_text(uuid, text, boolean), mavi_private.dossier_proposals_json(uuid, text[])
 from public, anon, authenticated;
revoke all on function public.client_dossier_decide(uuid, uuid, text), public.client_dossier_proposal_state(uuid, uuid[]),
 public.client_dossier_contest(uuid, uuid, text), public.client_dossier_resolve(uuid, uuid, text),
 public.client_dossier_context(uuid, uuid), public.client_dossier_ask(uuid, uuid),
 public.mavi_dossier_used(bigint, uuid[]), public.client_dossier_lookup(uuid, uuid[]) from public, anon;
grant execute on function public.client_dossier_decide(uuid, uuid, text), public.client_dossier_proposal_state(uuid, uuid[]),
 public.client_dossier_contest(uuid, uuid, text), public.client_dossier_resolve(uuid, uuid, text),
 public.client_dossier_context(uuid, uuid), public.client_dossier_ask(uuid, uuid),
 public.mavi_dossier_used(bigint, uuid[]), public.client_dossier_lookup(uuid, uuid[]) to authenticated;
revoke all on function public.ai_dossier_proposals(text, uuid) from public, anon, authenticated;
grant execute on function public.ai_dossier_proposals(text, uuid) to anon, authenticated;

commit;
