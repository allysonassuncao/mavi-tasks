begin;

-- MAVI · Radar pessoal, Fase 2: a resposta que a MAVI Assistente Pessoal
-- daria a cada situação, com as evidências e os links que ela sugere.
--
-- * Uma resposta por item e por dono (cada um no seu tom), escrita pela MAVI
--   com o login da pessoa (ação "personal-radar-draft" de /api/ai,
--   funcionalidade 'personal_assistant'): ela lê o cliente com as mesmas
--   ferramentas da MAVI (Drive, gravações, tarefas, campanhas ao vivo,
--   anotações sem o trecho secreto…) e devolve o texto pronto para colar no
--   WhatsApp, as evidências (só para a pessoa) e os links que criaria.
-- * Nada é enviado nem criado sozinho: os links (gravação, arquivo do Drive,
--   relatório de campanha) a pessoa cria na tela, se quiser, e o texto ela
--   copia. Copiar = aprovar ("approved"; com edição, "edited" e o texto final).
--   Reprovar tem motivo; "Ensinar a MAVI" guarda uma instrução. Tudo vai para
--   personal_radar_feedback, e as próximas respostas da pessoa já seguem os
--   últimos retornos dela (a Fase 3 consolida em lições).
-- * A resposta fica velha quando o cliente fala de novo no assunto: a MAVI
--   escreve outra.
-- * O custo conta no teto do mês da pessoa (ai_usage, módulo
--   'personal_radar', tipo 'reply').

create table public.personal_radar_replies (
 company_id uuid not null,
 item_id uuid not null references public.personal_radar_items(id) on delete cascade,
 user_id uuid not null,
 status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'rejected')),
 reply text not null default '' check (length(reply) <= 6000),
 -- [{title, detail, type, link?}]: o que embasa a resposta (só para a pessoa).
 evidence jsonb not null default '[]' check (jsonb_typeof(evidence) = 'array'),
 -- [{key, kind: recording | file | report, id, label, start?, end?}]: os
 -- links que ela criaria; {{key}} no texto vira o link.
 actions jsonb not null default '[]' check (jsonb_typeof(actions) = 'array'),
 -- O que a pessoa deve conferir antes de mandar.
 checks jsonb not null default '[]' check (jsonb_typeof(checks) = 'array'),
 confidence text check (confidence in ('high', 'medium', 'low')),
 -- A instrução do "Refazer" (só para a próxima versão).
 guidance text not null default '' check (length(guidance) <= 2000),
 model text not null default '',
 cost_usd numeric(12,6) not null default 0,
 version integer not null default 0,
 attempts integer not null default 0,
 claimed_until timestamptz,
 error text,
 -- A última fala do item quando a resposta foi escrita (mais nova = velha).
 based_on_at timestamptz,
 approved_at timestamptz,
 approved_text text check (length(approved_text) <= 6000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key (item_id, user_id),
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create index personal_radar_replies_user on public.personal_radar_replies(company_id, user_id, status);
alter table public.personal_radar_replies enable row level security;
revoke all on public.personal_radar_replies from public, anon, authenticated;

-- ------------------------------------------------------------ o que a MAVI pode linkar
-- Do cliente do item, só o que a pessoa vê: as gravações (regra do Drive),
-- os arquivos do Drive e, com Campanhas, as campanhas com os ciclos e os
-- relatórios que já têm link.
create function mavi_private.personal_radar_shareables(c uuid, p_client uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'recordings', case when mavi_private.drive_can_read(c, p_client) then coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', r.id, 'title', nullif(r.title, ''), 'at', to_char(r.recorded_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'),
    'token', case when s.recording_id is not null and (s.expires_at is null or s.expires_at > now()) then s.token end))
    order by r.recorded_at desc)
   from (select * from public.meeting_recordings x where x.company_id = c and x.client_id = p_client
    order by x.recorded_at desc limit 12) r
   left join public.meeting_shares s on s.recording_id = r.id), '[]') else '[]' end,
  'files', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', f.id, 'name', f.name, 'type', f.content_type, 'folder', fo.name,
    'at', to_char(f.created_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'),
    'token', case when f.visibility = 'public' then f.share_token end,
    'can_share', mavi_private.drive_manager(f))) order by f.created_at desc)
   from (select * from public.drive_files x where x.company_id = c and x.client_id = p_client and x.status = 'ready'
    and mavi_private.drive_file_readable(x) order by x.created_at desc limit 25) f
   left join public.drive_folders fo on fo.company_id = f.company_id and fo.id = f.folder_id), '[]'),
  'campaigns', case when mavi_private.module_client(c, 'campaigns', p_client) then coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', a.id, 'name', a.name, 'platform', a.platform, 'status', a.status,
    'cycle', (select jsonb_build_object('start', y.start_date, 'end', y.end_date, 'objective', y.objective)
     from public.ad_cycles y where y.company_id = a.company_id and y.campaign_id = a.id and y.start_date <= current_date
     order by y.start_date desc limit 1),
    'previous', (select jsonb_build_object('start', y.start_date, 'end', y.end_date, 'objective', y.objective)
     from public.ad_cycles y where y.company_id = a.company_id and y.campaign_id = a.id and y.end_date < current_date
     order by y.start_date desc limit 1),
    'reports', (select jsonb_agg(jsonb_build_object('id', rp.id, 'title', rp.title, 'start', rp.period_start,
      'end', rp.period_end, 'token', rp.token) order by rp.created_at desc)
     from (select * from public.ad_reports z where z.company_id = a.company_id and z.campaign_id = a.id
      and z.token is not null and (z.expires_at is null or z.expires_at > now())
      order by z.created_at desc limit 3) rp))) order by a.status, a.name)
   from public.ad_campaigns a
   join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id and k.client_id = p_client
   where a.company_id = c), '[]') else '[]' end)
$$;
revoke all on function mavi_private.personal_radar_shareables(uuid, uuid) from public, anon, authenticated;

-- A pessoa pode ter a resposta escrita: é dona, tem o módulo ligado e não
-- chegou ao teto do mês.
create function mavi_private.personal_radar_can_draft(c uuid, p_item uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.personal_radar_owners o
  join public.personal_radar_people p on p.company_id = o.company_id and p.user_id = o.user_id and p.active
  where o.company_id = c and o.item_id = p_item and o.user_id = auth.uid())
  and mavi_private.personal_radar_allowed(c, auth.uid())
$$;
revoke all on function mavi_private.personal_radar_can_draft(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ a resposta
-- O próximo item da pessoa que precisa de resposta (aberto, sem resposta ou
-- com resposta velha), do mais urgente para o menos; nulo quando não há ou no
-- teto do mês.
create function public.personal_radar_draft_next(p_company uuid) returns uuid
language sql stable security definer set search_path = '' as $$
 select i.id from public.personal_radar_owners o
 join public.personal_radar_items i on i.id = o.item_id and i.status = 'open'
 join public.personal_radar_people p on p.company_id = o.company_id and p.user_id = o.user_id and p.active
 left join public.personal_radar_replies r on r.item_id = i.id and r.user_id = o.user_id
 where o.company_id = p_company and o.user_id = auth.uid() and o.state = 'open'
  and mavi_private.personal_radar_allowed(p_company, auth.uid())
  and mavi_private.personal_radar_spent(p_company, auth.uid()) < mavi_private.personal_radar_cap(p_company, auth.uid())
  and i.client_id = any(mavi_private.served_clients_of(p_company, auth.uid()))
  and (r.item_id is null
   or r.status = 'pending'
   or (r.status = 'done' and r.approved_at is null and r.based_on_at < i.last_at)
   or (r.status = 'failed' and r.attempts < 3 and r.updated_at < now() - interval '10 minutes')
   or (r.status = 'running' and r.claimed_until < now() and r.attempts < 3))
 order by i.urgency desc, i.last_at desc
 limit 1
$$;

-- Começa a resposta de um item: confere, reserva por 4 minutos e devolve o
-- material. Já pronta e em dia (sem p_force), ou sendo escrita, volta só o
-- estado. p_guidance: a instrução do "Refazer".
create function public.personal_radar_draft_start(p_company uuid, p_item uuid, p_force boolean default false,
 p_guidance text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; r public.personal_radar_replies; v_keys text[]; begin
 if not mavi_private.personal_radar_can_draft(p_company, p_item) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 if length(coalesce(p_guidance, '')) > 2000 then
  raise exception 'Escreva a instrução em até 2.000 caracteres.' using errcode = '22023';
 end if;
 select * into i from public.personal_radar_items where id = p_item;
 if not i.client_id = any(mavi_private.served_clients_of(p_company, v_me)) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 select * into r from public.personal_radar_replies where item_id = p_item and user_id = v_me for update;
 if r.status = 'running' and r.claimed_until > now() then
  return jsonb_build_object('status', 'running');
 end if;
 if not coalesce(p_force, false) and r.status = 'done' and (r.approved_at is not null or r.based_on_at >= i.last_at) then
  return jsonb_build_object('status', 'done');
 end if;
 if mavi_private.personal_radar_spent(p_company, v_me) >= mavi_private.personal_radar_cap(p_company, v_me) then
  raise exception 'Você chegou ao teto do mês do Radar pessoal. A MAVI volta a escrever no próximo mês (ou peça um teto maior a um administrador).'
   using errcode = '54000';
 end if;
 insert into public.personal_radar_replies as x (company_id, item_id, user_id, status, attempts, claimed_until, guidance)
 values (p_company, p_item, v_me, 'running', 1, now() + interval '4 minutes', coalesce(btrim(p_guidance), ''))
 on conflict (item_id, user_id) do update set status = 'running', claimed_until = excluded.claimed_until,
  attempts = case when x.status in ('failed', 'running') then x.attempts + 1 else 1 end,
  guidance = case when p_guidance is null then x.guidance else excluded.guidance end,
  error = null, updated_at = now();
 -- A tela mostra que a MAVI está escrevendo.
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'personal_radar', 'people', jsonb_build_array(v_me)));
 v_keys := mavi_private.team_phone_keys(p_company);
 return jsonb_build_object(
  'status', 'claimed',
  'item', jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'summary', i.summary, 'urgency', i.urgency,
   'asks', i.asks, 'client_id', i.client_id, 'client_name', (select name from public.clients where id = i.client_id),
   'group', (select title from public.whatsapp_groups where id = i.group_id),
   'first_at', to_char(i.first_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'),
   'last_at', i.last_at,
   'task', (select jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status) from public.tasks t
    where t.id = i.task_id and not t.archived),
   'radar', (select jsonb_build_object('id', x.id, 'title', x.title) from public.radar_items x where x.id = i.radar_item_id),
   'reason', (select o.why from public.personal_radar_owners o where o.item_id = i.id and o.user_id = v_me)),
  'quotes', (select coalesce(jsonb_agg(jsonb_build_object('role', q.role, 'who', q.speaker, 'text', q.quote,
    'at', to_char(q.at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')) order by q.at), '[]')
   from (select * from public.personal_radar_mentions pm where pm.item_id = i.id order by pm.at desc limit 10) q),
  -- A conversa do grupo em volta (as 30 mensagens até agora).
  'conversation', (select coalesce(jsonb_agg(jsonb_build_object('role', m.role, 'who', m.who, 'text', left(m.line, 500),
    'at', to_char(m.sent_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')) order by m.sent_at, m.id), '[]')
   from (select w.id, w.sent_at, mavi_private.whatsapp_line(w) as line, mavi_private.personal_radar_who(w) as who,
     case when w.from_me or mavi_private.phone_key(nullif(w.sender_phone, '')) = any(v_keys) then 'team' else 'client' end as role
    from public.whatsapp_messages w where w.company_id = i.company_id and w.group_id = i.group_id
     and w.kind not in ('reaction', 'sticker') and w.sent_at >= i.first_at - interval '2 days'
    order by w.sent_at desc, w.id desc limit 30) m where coalesce(m.line, '') <> ''),
  'person', (select jsonb_build_object('name', mm.name, 'about', coalesce(p.about, ''),
    'teams', (select coalesce(jsonb_agg(distinct t.name), '[]') from public.team_members tm
     join public.teams t on t.company_id = tm.company_id and t.id = tm.team_id
     where tm.company_id = p_company and tm.user_id = v_me))
   from public.memberships mm left join public.personal_radar_people p on p.company_id = mm.company_id and p.user_id = mm.user_id
   where mm.company_id = p_company and mm.user_id = v_me),
  -- O tom da pessoa: as últimas respostas que ela mandou (aprovadas).
  'style', (select coalesce(jsonb_agg(x.final order by x.created_at desc), '[]') from (
   select left(y.snapshot->>'final', 1500) as final, y.created_at from public.personal_radar_feedback y
   where y.company_id = p_company and y.user_id = v_me and y.action in ('approved', 'edited')
    and coalesce(y.snapshot->>'final', '') <> ''
   order by y.created_at desc limit 4) x),
  -- O que ela ensinou: edições, reprovações e instruções recentes.
  'feedback', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('action', f.action, 'note', nullif(f.note, ''),
    'reason', f.snapshot->>'reason', 'title', f.snapshot->>'title', 'draft', left(f.snapshot->>'draft', 600),
    'final', left(f.snapshot->>'final', 600))) order by f.created_at desc), '[]')
   from (select * from public.personal_radar_feedback z where z.company_id = p_company and z.user_id = v_me
    and z.action in ('edited', 'rejected', 'training') order by z.created_at desc limit 10) f),
  'guidance', case when p_guidance is null then coalesce(r.guidance, '') else coalesce(btrim(p_guidance), '') end,
  'previous', case when r.status in ('done', 'rejected') and r.reply <> '' then r.reply end,
  'shareables', mavi_private.personal_radar_shareables(p_company, i.client_id));
end $$;

-- Grava a resposta escrita: p_draft = {reply, evidence, actions, checks,
-- confidence, model}; p_usage = {model, input, output, cache_read,
-- cache_write, embedding, cost, provider_id, provider}.
create function public.personal_radar_draft_store(p_company uuid, p_item uuid, p_draft jsonb, p_usage jsonb default '{}')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; v_cost numeric; v_conf text; begin
 if not mavi_private.personal_radar_can_draft(p_company, p_item) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 select * into i from public.personal_radar_items where id = p_item;
 if coalesce(btrim(p_draft->>'reply'), '') = '' then raise exception 'A resposta veio vazia.' using errcode = '22023'; end if;
 v_conf := case when p_draft->>'confidence' in ('high', 'medium', 'low') then p_draft->>'confidence' end;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 update public.personal_radar_replies set status = 'done', reply = left(p_draft->>'reply', 6000),
  evidence = case when jsonb_typeof(p_draft->'evidence') = 'array' then (select coalesce(jsonb_agg(e), '[]')
   from (select e from jsonb_array_elements(p_draft->'evidence') e where jsonb_typeof(e) = 'object' limit 12) s) else '[]' end,
  actions = case when jsonb_typeof(p_draft->'actions') = 'array' then (select coalesce(jsonb_agg(e), '[]')
   from (select e from jsonb_array_elements(p_draft->'actions') e where jsonb_typeof(e) = 'object'
    and e->>'kind' in ('recording', 'file', 'report') limit 6) s) else '[]' end,
  checks = case when jsonb_typeof(p_draft->'checks') = 'array' then (select coalesce(jsonb_agg(left(e, 300)), '[]')
   from (select e from jsonb_array_elements_text(p_draft->'checks') e limit 6) s) else '[]' end,
  confidence = v_conf, model = left(coalesce(p_draft->>'model', p_usage->>'model', ''), 80),
  cost_usd = cost_usd + v_cost, version = version + 1, claimed_until = null, error = null,
  based_on_at = i.last_at, approved_at = null, approved_text = null, updated_at = now()
 where item_id = p_item and user_id = v_me;
 if not found then raise exception 'A resposta não estava reservada.' using errcode = 'P0002'; end if;
 insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, embedding_tokens, cost_usd, provider_id, provider_name)
 values (p_company, v_me, 'personal_radar', 'reply', i.client_id, left(coalesce(p_usage->>'model', ''), 80),
  coalesce((p_usage->>'input')::integer, 0), coalesce((p_usage->>'output')::integer, 0),
  coalesce((p_usage->>'cache_read')::integer, 0), coalesce((p_usage->>'cache_write')::integer, 0),
  coalesce((p_usage->>'embedding')::integer, 0), v_cost,
  case when (p_usage->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then (p_usage->>'provider_id')::uuid end,
  left(coalesce(p_usage->>'provider', ''), 120));
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'personal_radar', 'people', jsonb_build_array(v_me)));
 return mavi_private.personal_radar_item_json(i, v_me);
end $$;

-- Não deu para escrever: volta para a fila (até 3 tentativas).
create function public.personal_radar_draft_fail(p_company uuid, p_item uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 update public.personal_radar_replies set status = 'failed', claimed_until = null, error = left(p_error, 500), updated_at = now()
 where company_id = p_company and item_id = p_item and user_id = auth.uid() and status = 'running';
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'personal_radar', 'people', jsonb_build_array(auth.uid())));
end $$;

-- O que a pessoa faz com a resposta:
--  approved: copiou como estava · edited: copiou editada (p_text = o final)
--  rejected: reprovou (p_reason: wrong_info | wrong_tone | incomplete |
--   should_not_reply | other; p_text = a nota)
--  training: "Ensinar a MAVI" (p_text = a instrução)
create function public.personal_radar_reply_feedback(p_company uuid, p_item uuid, p_action text, p_text text default '',
 p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; r public.personal_radar_replies; begin
 if not exists (select 1 from public.personal_radar_owners where company_id = p_company and item_id = p_item and user_id = v_me)
  or not mavi_private.member(p_company) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 if p_action not in ('approved', 'edited', 'rejected', 'training') then
  raise exception 'Ação inválida' using errcode = '22023';
 end if;
 if p_action = 'rejected' and coalesce(p_reason, '') not in ('wrong_info', 'wrong_tone', 'incomplete', 'should_not_reply', 'other') then
  raise exception 'Escolha o motivo.' using errcode = '22023';
 end if;
 if p_action in ('edited', 'training') and coalesce(btrim(p_text), '') = '' then
  raise exception 'Escreva o texto.' using errcode = '22023';
 end if;
 if length(coalesce(p_text, '')) > 4000 then raise exception 'Escreva em até 4.000 caracteres.' using errcode = '22023'; end if;
 select * into i from public.personal_radar_items where id = p_item;
 select * into r from public.personal_radar_replies where item_id = p_item and user_id = v_me for update;
 if p_action in ('approved', 'edited', 'rejected') and (r.item_id is null or r.reply = '') then
  raise exception 'A MAVI ainda não escreveu esta resposta.' using errcode = 'P0002';
 end if;
 if p_action in ('approved', 'edited') then
  update public.personal_radar_replies set approved_at = now(),
   approved_text = left(case when p_action = 'edited' then p_text else reply end, 6000),
   status = 'done', updated_at = now()
  where item_id = p_item and user_id = v_me;
 elsif p_action = 'rejected' then
  update public.personal_radar_replies set status = 'rejected', approved_at = null, approved_text = null, updated_at = now()
  where item_id = p_item and user_id = v_me;
 end if;
 insert into public.personal_radar_feedback(company_id, item_id, user_id, action, note, snapshot)
 values (p_company, p_item, v_me, p_action,
  case when p_action in ('rejected', 'training') then coalesce(btrim(p_text), '') else '' end,
  jsonb_strip_nulls(jsonb_build_object('kind', i.kind, 'title', i.title, 'summary', i.summary,
   'client', (select name from public.clients where id = i.client_id),
   'reason', p_reason, 'draft', nullif(r.reply, ''), 'version', r.version, 'model', nullif(r.model, ''),
   'final', case when p_action = 'edited' then p_text when p_action = 'approved' then r.reply end)));
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'personal_radar', 'people', jsonb_build_array(v_me)));
 return mavi_private.personal_radar_item_json(i, v_me);
end $$;

-- ------------------------------------------------------------ a tela
-- A da migração 20270304090000, com a resposta de quem olha.
create or replace function mavi_private.personal_radar_item_json(i public.personal_radar_items, p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_strip_nulls(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'summary', i.summary,
  'urgency', i.urgency, 'status', i.status, 'asks', i.asks, 'first_at', i.first_at, 'last_at', i.last_at,
  'resolved_at', i.resolved_at, 'resolved_how', i.resolved_how, 'resolved_by_name', i.resolved_by_name,
  'reopened_at', i.reopened_at,
  'client', jsonb_build_object('id', i.client_id, 'name', (select k.name from public.clients k where k.id = i.client_id)),
  'group', jsonb_build_object('id', i.group_id, 'title', (select w.title from public.whatsapp_groups w where w.id = i.group_id)),
  'reason', o.reason, 'why', o.why, 'state', o.state, 'dismissed_reason', o.dismissed_reason,
  'others', (select jsonb_agg(m.name order by m.name) from public.personal_radar_owners x
   join public.memberships m on m.company_id = x.company_id and m.user_id = x.user_id
   where x.item_id = i.id and x.user_id <> p_user and x.state = 'open'),
  'mentions', (select jsonb_agg(jsonb_build_object('message_id', q.message_id, 'role', q.role, 'speaker', q.speaker,
    'quote', q.quote, 'at', q.at) order by q.at) from (select * from public.personal_radar_mentions pm
    where pm.item_id = i.id order by pm.at desc limit 4) q),
  'mention_count', (select count(*) from public.personal_radar_mentions pm where pm.item_id = i.id),
  'task', (select jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status) from public.tasks t
   where t.id = i.task_id and not t.archived and (mavi_private.leader(i.company_id) or mavi_private.task_access(i.company_id, t.id))),
  'radar', (select jsonb_build_object('id', r.id, 'title', r.title) from public.radar_items r where r.id = i.radar_item_id),
  'reply', (select jsonb_strip_nulls(jsonb_build_object('status', case when r.status = 'running' and r.claimed_until < now()
     then 'failed' else r.status end,
    'text', nullif(r.reply, ''), 'evidence', r.evidence, 'actions', r.actions, 'checks', r.checks,
    'confidence', r.confidence, 'model', nullif(r.model, ''), 'version', r.version, 'error', r.error,
    'updated_at', r.updated_at, 'approved_at', r.approved_at, 'approved_text', r.approved_text,
    'stale', r.status = 'done' and r.approved_at is null and r.based_on_at < i.last_at,
    'guidance', nullif(r.guidance, '')))
   from public.personal_radar_replies r where r.item_id = i.id and r.user_id = p_user)))
 from public.personal_radar_owners o where o.item_id = i.id and o.user_id = p_user
$$;

revoke all on function public.personal_radar_draft_next(uuid), public.personal_radar_draft_start(uuid, uuid, boolean, text),
 public.personal_radar_draft_store(uuid, uuid, jsonb, jsonb), public.personal_radar_draft_fail(uuid, uuid, text),
 public.personal_radar_reply_feedback(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.personal_radar_draft_next(uuid), public.personal_radar_draft_start(uuid, uuid, boolean, text),
 public.personal_radar_draft_store(uuid, uuid, jsonb, jsonb), public.personal_radar_draft_fail(uuid, uuid, text),
 public.personal_radar_reply_feedback(uuid, uuid, text, text, text) to authenticated;

commit;
