begin;

-- MAVI · Radar: excluir casos, a base dos Agentes Conversacionais e o
-- aprendizado por produto.
--
-- * Excluir um caso (Radar › Cliente: administradores e gestores; Radar ›
--   Pessoal: quem é dono): o item sai de vez, com o motivo guardado em
--   radar_removals. "Erro da MAVI" e "Não é do cliente" também desfazem o
--   Termômetro: as falas do caso entram em temperature_exclusions, o Jev lê
--   de novo a reunião ou o dia do grupo sem elas e o dia é recalculado. No
--   Radar do cliente, os casos excluídos entram na leitura seguinte como
--   exemplos do que não anotar; no pessoal, viram um retorno "não é uma
--   situação" para o aprendizado da pessoa.
-- * Base dos Agentes Conversacionais: os prompts do robô de WhatsApp do
--   cliente (os fluxos do produto MAVI ligados a ele) — inteiros quando cabem,
--   senão os trechos que mais têm a ver com o caso. Os dois Radares conferem
--   cada caso com eles (agent_check: o robô já tem a informação, falta, está
--   diferente ou não tem a ver), propõem o ajuste no prompt (quem edita no
--   Drive revisa e publica pelo Agente Conversacional) e fecham sozinhos o
--   que já estava resolvido. A resposta sugerida do Radar pessoal usa a
--   mesma base.
-- * Produto no Radar pessoal: a MAVI escolhe entre os produtos ativos do
--   cliente e a pessoa corrige.
-- * Aprendizado por produto: a MAVI junta os retornos das respostas (copiou,
--   editou, reprovou, ensinou) de todas as pessoas num produto e sugere
--   lições do produto; o Jev confere e elas só valem depois que um
--   administrador ou gestor aprova. Líderes escrevem as suas (valem na
--   hora), editam, pausam e excluem.
-- * Respostas menos repetidas: os exemplos de tom vêm das respostas da
--   pessoa mais parecidas com a situação (tipo, cliente, produto), e as
--   aprovadas do produto entram como referência de conteúdo.

-- ------------------------------------------------------------ casos excluídos
create table public.radar_removals (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 radar text not null check (radar in ('client', 'personal')),
 item_id uuid not null,
 client_id uuid,
 -- O tópico (Radar do cliente) ou o tipo da situação (pessoal).
 topic text not null default '',
 title text not null default '',
 summary text not null default '',
 reason text not null check (reason in ('mavi_error', 'not_client', 'duplicate', 'other')),
 note text not null default '' check (length(note) <= 1000),
 -- [{quote, speaker, role, at}] (até 20).
 quotes jsonb not null default '[]' check (jsonb_typeof(quotes) = 'array'),
 -- Quantas leituras do Termômetro foram refeitas.
 temperature integer not null default 0,
 removed_by uuid,
 removed_at timestamptz not null default now(),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
create index radar_removals_client on public.radar_removals (company_id, radar, client_id, removed_at desc);
alter table public.radar_removals enable row level security;
revoke all on public.radar_removals from public, anon, authenticated;

-- As falas que o Termômetro não lê mais: a mensagem do grupo (WhatsApp) ou o
-- segundo da fala (reunião). source_id é o da leitura (a gravação ou o dia
-- do grupo, como em temperature_signals).
create table mavi_private.temperature_exclusions (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 client_id uuid not null,
 source_type text not null check (source_type in ('meeting', 'whatsapp')),
 source_id uuid not null,
 message_id uuid,
 at_seconds integer,
 removal_id uuid references public.radar_removals(id) on delete cascade,
 created_at timestamptz not null default now(),
 check (message_id is not null or at_seconds is not null)
);
create index temperature_exclusions_source on mavi_private.temperature_exclusions (source_type, source_id);
create index temperature_exclusions_message on mavi_private.temperature_exclusions (message_id) where message_id is not null;
revoke all on mavi_private.temperature_exclusions from public, anon, authenticated;

-- As leituras com fala excluída voltam para a fila (o worker lê o que passou
-- 20 minutos parado: já entram na próxima rodada). Retirada continua
-- retirada (o gatilho da migração 20270508090000 a mantém 'skipped').
create function mavi_private.temperature_exclusions_reread(p_removal uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; begin
 update public.temperature_signals s set status = 'pending', dirty_at = now() - interval '21 minutes',
  claimed_until = null, attempts = 0, last_error = null
 where exists (select 1 from mavi_private.temperature_exclusions x
  where x.removal_id = p_removal and x.source_type = s.source_type and x.source_id = s.source_id
   and x.company_id = s.company_id);
 get diagnostics n = row_count;
 return n;
end $$;
revoke all on function mavi_private.temperature_exclusions_reread(uuid) from public, anon, authenticated;

-- A da migração 20261113090000, sem as falas excluídas.
create or replace function mavi_private.temperature_material(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare g public.temperature_signals; r record; v_names text[]; v_keys text[]; v_lines text;
 v_client_lines integer; v_first uuid; v_excerpt text; v_summary text; v_team text[]; v_other text[];
 v_products text; v_from timestamptz; v_to timestamptz; v_skip integer[]; begin
 select * into g from public.temperature_signals where id = p_id;
 if not found then return null; end if;
 select coalesce(string_agg(distinct pr.name, ', '), '') into v_products from public.contracts k
 join public.products pr on pr.company_id = k.company_id and pr.id = k.product_id
 where k.company_id = g.company_id and k.client_id = g.client_id and not k.archived;

 if g.source_type = 'meeting' then
  select mr.*, t.speakers as t_speakers, t.segments into r from public.meeting_recordings mr
  left join public.meeting_transcripts t on t.company_id = mr.company_id and t.recording_id = mr.id
  where mr.company_id = g.company_id and mr.id = g.source_id;
  if not found then return null; end if;
  -- Os segundos das falas excluídas (casos do Radar apagados como erro).
  select coalesce(array_agg(x.at_seconds), '{}') into v_skip from mavi_private.temperature_exclusions x
  where x.source_type = 'meeting' and x.source_id = g.source_id and x.at_seconds is not null;
  -- Os nomes do time, já normalizados (quem gravou também é membro).
  select coalesce(array_agg(distinct mavi_private.temperature_norm(x.name)), '{}') into v_names
  from public.memberships x where x.company_id = g.company_id;
  -- Materializadas: os papéis são decididos uma vez por falante, não por fala.
  with seg as materialized (
   select e.n, btrim(coalesce(e.s->>3, '')) as txt,
    coalesce(nullif(r.t_speakers[((e.s->>2)::integer) + 1], ''), 'Falante ' || (coalesce((e.s->>2)::integer, 0) + 1)) as who
   from jsonb_array_elements(coalesce(r.segments, '[]')) with ordinality e(s, n)
   where cardinality(v_skip) = 0
    or not (greatest(floor(coalesce(nullif(e.s->>0, '')::numeric, 0)), 0)::integer = any(v_skip))
  ), roles as materialized (
   select q.who, case when q.who ~ '^Falante \d+$' then 'não identificado'
    when mavi_private.temperature_is_team(q.who, v_names) then 'time'
    else 'cliente' end as role
   from (select distinct seg.who from seg) q
  )
  select string_agg(format('[%s] %s: %s', ro.role, seg.who, seg.txt), E'\n' order by seg.n),
   count(*) filter (where ro.role <> 'time'),
   coalesce(array_agg(distinct seg.who) filter (where ro.role = 'time'), '{}'),
   coalesce(array_agg(distinct seg.who) filter (where ro.role = 'cliente'), '{}'),
   left(string_agg(seg.txt, ' ' order by seg.n) filter (where ro.role <> 'time'), 500)
  into v_lines, v_client_lines, v_team, v_other, v_excerpt
  from seg join roles ro on ro.who = seg.who;
  v_summary := concat_ws(E'\n',
   case when r.summary->>'overview' is not null then 'Resumo: ' || (r.summary->>'overview') end,
   (select string_agg('- ' || (nt->>'title') || ': ' || (nt->>'description'), E'\n')
     from jsonb_array_elements(coalesce(r.summary->'notes', '[]')) nt));
  if btrim(coalesce(v_lines, '')) = '' and btrim(coalesce(v_summary, '')) = '' then return null; end if;
  if nullif(r.summary->>'overview', '') is not null then v_excerpt := left(r.summary->>'overview', 500); end if;
  return jsonb_build_object('client_lines', greatest(coalesce(v_client_lines, 0),
    case when coalesce(v_summary, '') <> '' then 1 else 0 end),
   'message_id', null, 'excerpt', left(coalesce(v_excerpt, ''), 500),
   'state', jsonb_strip_nulls(jsonb_build_object(
    'fonte', 'Reunião gravada com o cliente (transcrição automática: nomes e palavras podem sair errados)',
    'cliente', (select name from public.clients where id = g.client_id),
    'produtos_contratados', nullif(v_products, ''),
    'data', to_char(r.recorded_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'),
    'titulo', coalesce(nullif(r.summary->>'title', ''), nullif(r.title, ''), 'Reunião'),
    'participantes_do_time', case when cardinality(v_team) > 0 then to_jsonb(v_team) end,
    'participantes_do_cliente', case when cardinality(v_other) > 0 then to_jsonb(v_other) end,
    'resumo', nullif(left(coalesce(v_summary, ''), 6000), ''),
    'legenda', 'Cada fala começa com [time] (a agência), [cliente] ou [não identificado]. Avalie o cliente.',
    'transcricao', nullif(mavi_private.temperature_clip(coalesce(v_lines, ''), 60000), ''))));
 end if;

 -- WhatsApp: as mensagens do dia do grupo, marcadas por quem mandou.
 select d.*, wg.title as group_title into r from mavi_private.whatsapp_ai_days d
 join public.whatsapp_groups wg on wg.company_id = d.company_id and wg.id = d.group_id
 where d.id = g.source_id;
 if not found then return null; end if;
 v_keys := mavi_private.team_phone_keys(g.company_id);
 v_from := r.day::timestamp at time zone 'America/Sao_Paulo';
 v_to := (r.day + 1)::timestamp at time zone 'America/Sao_Paulo';
 with msg as (
  select w.id, w.sent_at, w.kind, mavi_private.whatsapp_line(w) as line, mavi_private.whatsapp_sender(w) as who,
   case when w.from_me or mavi_private.phone_key(w.sender_phone) = any(v_keys) then 'time' else 'cliente' end as role
  from public.whatsapp_messages w
  where w.company_id = r.company_id and w.group_id = r.group_id and w.sent_at >= v_from and w.sent_at < v_to
   and not exists (select 1 from mavi_private.temperature_exclusions x where x.message_id = w.id)
 )
 select string_agg(format('%s [%s] %s: %s', to_char(msg.sent_at at time zone 'America/Sao_Paulo', 'HH24:MI'),
   msg.role, msg.who, msg.line), E'\n' order by msg.sent_at, msg.id),
  count(*) filter (where msg.role = 'cliente' and msg.kind <> 'reaction'),
  (array_agg(msg.id order by msg.sent_at, msg.id) filter (where msg.role = 'cliente' and msg.kind <> 'reaction'))[1],
  left(string_agg(left(msg.line, 300), ' · ' order by msg.sent_at, msg.id)
   filter (where msg.role = 'cliente' and msg.kind <> 'reaction'), 500)
 into v_lines, v_client_lines, v_first, v_excerpt
 from msg where coalesce(msg.line, '') <> '';
 if coalesce(v_client_lines, 0) = 0 then
  return jsonb_build_object('client_lines', 0, 'message_id', null, 'excerpt', '', 'state', null);
 end if;
 return jsonb_build_object('client_lines', v_client_lines, 'message_id', v_first, 'excerpt', coalesce(v_excerpt, ''),
  'state', jsonb_strip_nulls(jsonb_build_object(
   'fonte', 'Grupo de WhatsApp da agência com o cliente (áudios aparecem transcritos)',
   'cliente', (select name from public.clients where id = g.client_id),
   'produtos_contratados', nullif(v_products, ''),
   'grupo', r.group_title,
   'data', to_char(r.day, 'DD/MM/YYYY'),
   'legenda', 'Cada mensagem traz o horário e [time] (a agência) ou [cliente]. Avalie o cliente.',
   'conversa', case when length(v_lines) > 60000 then '[… mensagens anteriores omitidas …]' || E'\n' || right(v_lines, 60000)
    else v_lines end)));
end $$;
revoke all on function mavi_private.temperature_material(uuid) from public, anon, authenticated;

-- Excluir um caso do Radar do cliente (administradores e gestores que veem o
-- cliente no Radar). p_reason: mavi_error | not_client | duplicate | other.
create function public.remove_radar_item(p_company uuid, p_item uuid, p_reason text, p_note text default '')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.radar_items; v_id uuid; v_temp integer := 0; v_note text := btrim(coalesce(p_note, '')); begin
 select * into i from public.radar_items where company_id = p_company and id = p_item for update;
 if not found then raise exception 'Item não encontrado.' using errcode = 'P0002'; end if;
 if not mavi_private.leader(p_company) or not mavi_private.module_client(p_company, 'radar', i.client_id) then
  raise exception 'Só administradores e gestores excluem casos do Radar.' using errcode = '42501';
 end if;
 if coalesce(p_reason, '') not in ('mavi_error', 'not_client', 'duplicate', 'other') then
  raise exception 'Escolha o motivo.' using errcode = '22023';
 end if;
 if length(v_note) > 1000 then raise exception 'Escreva em até 1.000 caracteres.' using errcode = '22023'; end if;
 if p_reason = 'other' and v_note = '' then raise exception 'Conte o motivo.' using errcode = '22023'; end if;
 insert into public.radar_removals(company_id, radar, item_id, client_id, topic, title, summary, reason, note, quotes, removed_by)
 values (p_company, 'client', i.id, i.client_id, coalesce((select t.name from public.radar_topics t where t.id = i.topic_id), ''),
  i.title, i.summary, p_reason, v_note,
  coalesce((select jsonb_agg(jsonb_build_object('quote', left(m.quote, 400), 'speaker', m.speaker, 'role', m.role,
    'at', m.occurred_at) order by m.occurred_at) from (select * from public.radar_mentions x where x.item_id = i.id
    order by x.occurred_at desc limit 20) m), '[]'),
  auth.uid())
 returning id into v_id;
 -- Erro de leitura: o Termômetro deixa de contar essas falas (as que não são
 -- de outro caso que continua no Radar).
 if p_reason in ('mavi_error', 'not_client') then
  insert into mavi_private.temperature_exclusions(company_id, client_id, source_type, source_id, message_id, at_seconds, removal_id)
  select distinct m.company_id, i.client_id, m.source_type, m.source_id, m.message_id,
   case when m.message_id is null then m.at_seconds end, v_id
  from public.radar_mentions m
  where m.item_id = i.id and m.role <> 'team' and (m.message_id is not null or m.at_seconds is not null)
   and not exists (select 1 from public.radar_mentions o where o.item_id <> i.id and o.source_id = m.source_id
    and (o.message_id = m.message_id or (m.message_id is null and o.at_seconds = m.at_seconds)));
  v_temp := mavi_private.temperature_exclusions_reread(v_id);
  update public.radar_removals set temperature = v_temp where id = v_id;
 end if;
 update public.personal_radar_items set radar_item_id = null where radar_item_id = i.id;
 delete from public.radar_items where id = i.id;
 return jsonb_build_object('removed', true, 'temperature', v_temp);
end $$;

-- Excluir uma situação do Radar pessoal (quem é dono dela; some para todos).
create function public.personal_radar_remove(p_company uuid, p_item uuid, p_reason text, p_note text default '')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; o public.personal_radar_owners; v_id uuid;
 v_temp integer := 0; v_note text := btrim(coalesce(p_note, '')); v_people jsonb; begin
 select * into o from public.personal_radar_owners where company_id = p_company and item_id = p_item and user_id = v_me;
 if not found or not mavi_private.member(p_company) then raise exception 'Item não encontrado' using errcode = 'P0002'; end if;
 select * into i from public.personal_radar_items where id = p_item for update;
 if coalesce(p_reason, '') not in ('mavi_error', 'not_client', 'duplicate', 'other') then
  raise exception 'Escolha o motivo.' using errcode = '22023';
 end if;
 if length(v_note) > 1000 then raise exception 'Escreva em até 1.000 caracteres.' using errcode = '22023'; end if;
 if p_reason = 'other' and v_note = '' then raise exception 'Conte o motivo.' using errcode = '22023'; end if;
 select coalesce(jsonb_agg(x.user_id), '[]') into v_people from public.personal_radar_owners x where x.item_id = i.id;
 insert into public.radar_removals(company_id, radar, item_id, client_id, topic, title, summary, reason, note, quotes, removed_by)
 values (p_company, 'personal', i.id, i.client_id, i.kind, i.title, i.summary, p_reason, v_note,
  coalesce((select jsonb_agg(jsonb_build_object('quote', left(m.quote, 400), 'speaker', m.speaker, 'role', m.role,
    'at', m.at) order by m.at) from (select * from public.personal_radar_mentions x where x.item_id = i.id
    order by x.at desc limit 20) m), '[]'),
  v_me)
 returning id into v_id;
 if p_reason in ('mavi_error', 'not_client') then
  -- As mensagens do cliente do caso, no dia do grupo em que foram ditas.
  insert into mavi_private.temperature_exclusions(company_id, client_id, source_type, source_id, message_id, removal_id)
  select distinct i.company_id, i.client_id, 'whatsapp', d.id, m.message_id, v_id
  from public.personal_radar_mentions m
  join public.whatsapp_messages w on w.id = m.message_id
  join mavi_private.whatsapp_ai_days d on d.group_id = w.group_id
   and d.day = (w.sent_at at time zone 'America/Sao_Paulo')::date
  where m.item_id = i.id and m.role = 'client'
   and not exists (select 1 from public.personal_radar_mentions x where x.message_id = m.message_id and x.item_id <> i.id);
  v_temp := mavi_private.temperature_exclusions_reread(v_id);
  update public.radar_removals set temperature = v_temp where id = v_id;
  -- O aprendizado da pessoa: não era uma situação.
  insert into public.personal_radar_feedback(company_id, item_id, user_id, action, note, snapshot)
  values (p_company, null, v_me, 'not_situation',
   left(concat_ws(' — ', case p_reason when 'not_client' then 'Excluída: quem falou não era o cliente.'
    else 'Excluída: a MAVI leu errado.' end, nullif(v_note, '')), 4000),
   jsonb_build_object('kind', i.kind, 'title', i.title, 'summary', i.summary, 'reason', o.reason, 'why', o.why,
    'client', (select k.name from public.clients k where k.id = i.client_id)));
 end if;
 delete from public.personal_radar_items where id = i.id;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'personal_radar', 'people', v_people));
 return jsonb_build_object('removed', true, 'temperature', v_temp);
end $$;

-- Para a leitura do Radar do cliente: os casos excluídos (exemplos do que não
-- anotar), dos últimos 120 dias.
create function public.radar_removed_for_worker(p_secret text, p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('topic', r.topic, 'title', r.title,
   'reason', r.reason, 'note', nullif(r.note, ''),
   'quote', (select left(q->>'quote', 200) from jsonb_array_elements(r.quotes) q limit 1))) order by r.removed_at desc)
  from (select * from public.radar_removals x where x.radar = 'client' and x.client_id = p_client
   and x.reason <> 'other' and x.removed_at > now() - interval '120 days'
   order by x.removed_at desc limit 15) r), '[]');
end $$;

-- ------------------------------------------------------------ base dos agentes
-- Os prompts do robô do cliente (os mesmos de agent_prompts_for_worker):
-- inteiros quando todos cabem em p_chars; senão, os trechos que mais têm a
-- ver com p_query (o começo de cada prompt sempre entra: quem o robô é).
create function mavi_private.agent_knowledge(c uuid, p_client uuid, p_query text, p_chars integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_max integer := least(greatest(coalesce(p_chars, 24000), 2000), 60000); v_prompts jsonb; v_total integer;
 v_q tsquery; v_words text; v_out jsonb; begin
 select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'workflow', x.workflow, 'node', x.node, 'product', x.product,
   'role', x.role, 'active', x.active, 'prompt', x.prompt, 'rank', x.rank)), '[]'),
  coalesce(sum(length(x.prompt)), 0)
 into v_prompts, v_total
 from (select p.id, w.name as workflow, p.node_name as node, w.role, w.active, p.prompt,
   (select pr.name from public.contracts k join public.products pr on pr.company_id = k.company_id
    and pr.id = k.product_id where k.id = w.contract_id) as product,
   row_number() over (order by w.role = 'main' desc, w.active desc, w.name, p.node_name) as rank
  from public.agent_workflows w join public.agent_prompts p on p.workflow_id = w.id
  where w.company_id = c and w.client_id = p_client and w.removed_at is null and not w.ignored and w.role <> 'copy'
   and not w.archived and p.removed_at is null and btrim(p.prompt) <> '') x;
 if v_total = 0 then return '[]'; end if;
 if v_total <= v_max then
  return (select jsonb_agg(jsonb_strip_nulls((a.x - 'prompt' - 'rank') || jsonb_build_object('full', true,
    'chars', length(a.x->>'prompt'), 'text', a.x->>'prompt')) order by (a.x->>'rank')::integer)
   from jsonb_array_elements(v_prompts) a(x));
 end if;
 -- As palavras do caso (4 letras ou mais), em "ou".
 select string_agg(y.w, ' or ') into v_words from (
  select distinct w from regexp_split_to_table(lower(coalesce(p_query, '')), '[^[:alnum:]à-ÿ]+') w
  where length(w) >= 4 limit 60) y;
 v_q := case when coalesce(v_words, '') <> '' then websearch_to_tsquery('portuguese', v_words) end;
 with pieces as (
  select a.x->>'id' as id, (a.x->>'rank')::integer as rank, s.n, s.piece,
   case when s.n = 1 then 1000 when v_q is null then 0
    else ts_rank(to_tsvector('portuguese', s.piece), v_q) end as score
  from jsonb_array_elements(v_prompts) a(x), lateral mavi_private.ai_split(a.x->>'prompt') with ordinality s(piece, n)
 ), picked as (
  select p.*, sum(length(p.piece) + 2) over (order by p.score desc, p.rank, p.n) as running
  from pieces p where p.score > 0
 )
 select jsonb_agg(jsonb_strip_nulls((a.x - 'prompt' - 'rank') || jsonb_build_object('full', false,
   'chars', length(a.x->>'prompt'),
   'pieces', (select jsonb_agg(k.piece order by k.n) from picked k where k.id = a.x->>'id' and k.running <= v_max)))
   order by (a.x->>'rank')::integer)
 into v_out from jsonb_array_elements(v_prompts) a(x);
 return coalesce(v_out, '[]');
end $$;
revoke all on function mavi_private.agent_knowledge(uuid, uuid, text, integer) from public, anon, authenticated;

-- Para os workers do Radar (com o segredo da MAVI).
create function public.agent_knowledge_for_worker(p_secret text, p_company uuid, p_client uuid, p_query text,
 p_chars integer default 24000) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 return mavi_private.agent_knowledge(p_company, p_client, p_query, p_chars);
end $$;

-- Para a resposta sugerida (com o login da pessoa: quem vê o cliente).
create function public.agent_knowledge(p_company uuid, p_client uuid, p_query text, p_chars integer default 16000)
returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if p_client is null or not mavi_private.dossier_reader(p_company, p_client) then return '[]'; end if;
 return mavi_private.agent_knowledge(p_company, p_client, p_query, p_chars);
end $$;

-- A conferência de um caso com a base: {status: covered | missing | conflict
-- | unrelated, note, evidence: [{prompt_id, workflow, node, excerpt}],
-- suggestion: {prompt_id, workflow, node, before, after, why} | null, done,
-- checked_at}. Só os prompts do próprio cliente valem.
create function mavi_private.agent_check_clean(c uuid, p_client uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_ok uuid[]; s jsonb; begin
 if jsonb_typeof(p) is distinct from 'object' or coalesce(p->>'status', '') not in ('covered', 'missing', 'conflict', 'unrelated') then
  return null;
 end if;
 select coalesce(array_agg(pr.id), '{}') into v_ok from public.agent_prompts pr
 join public.agent_workflows w on w.id = pr.workflow_id
 where w.company_id = c and w.client_id = p_client and pr.removed_at is null;
 s := case when jsonb_typeof(p->'suggestion') = 'object' and (p->'suggestion'->>'prompt_id') ~* '^[0-9a-f-]{36}$'
   and (p->'suggestion'->>'prompt_id')::uuid = any(v_ok) and btrim(coalesce(p->'suggestion'->>'after', '')) <> ''
  then jsonb_build_object('prompt_id', p->'suggestion'->>'prompt_id',
   'workflow', left(coalesce(p->'suggestion'->>'workflow', ''), 300), 'node', left(coalesce(p->'suggestion'->>'node', ''), 300),
   'before', left(coalesce(p->'suggestion'->>'before', ''), 4000), 'after', left(p->'suggestion'->>'after', 4000),
   'why', left(coalesce(p->'suggestion'->>'why', ''), 500)) end;
 return jsonb_strip_nulls(jsonb_build_object('status', p->>'status', 'note', left(coalesce(p->>'note', ''), 600),
  'evidence', (select jsonb_agg(jsonb_build_object('prompt_id', e->>'prompt_id', 'workflow', left(coalesce(e->>'workflow', ''), 300),
    'node', left(coalesce(e->>'node', ''), 300), 'excerpt', left(coalesce(e->>'excerpt', ''), 600)))
   from (select e from jsonb_array_elements(case when jsonb_typeof(p->'evidence') = 'array' then p->'evidence' else '[]' end) e
    where (e->>'prompt_id') ~* '^[0-9a-f-]{36}$' and (e->>'prompt_id')::uuid = any(v_ok)
     and btrim(coalesce(e->>'excerpt', '')) <> '' limit 3) x),
  'suggestion', s, 'done', coalesce((p->>'done')::boolean, false), 'checked_at', now()));
exception when others then return null;
end $$;
revoke all on function mavi_private.agent_check_clean(uuid, uuid, jsonb) from public, anon, authenticated;

alter table public.radar_items add column agent_check jsonb;
alter table public.personal_radar_items
 add column agent_check jsonb,
 add column product_id uuid,
 -- A pessoa escolheu o produto: a MAVI não troca.
 add column product_person boolean not null default false,
 add constraint personal_radar_items_product foreign key (company_id, product_id)
  references public.products(company_id, id) on delete set null (product_id);
alter table public.personal_radar_items drop constraint personal_radar_items_resolved_how_check;
alter table public.personal_radar_items add constraint personal_radar_items_resolved_how_check
 check (resolved_how in ('auto', 'person', 'knowledge'));

-- O resultado da conferência no Radar do cliente, depois da leitura:
-- p_checks = [{message_id | at_seconds, check}] (a fala que identifica o
-- item nesta leitura). done num item novo e aberto: fecha no primeiro status
-- fechado do tópico (a MAVI fechou; o motivo fica na conferência).
create function public.ai_radar_agent_store(p_secret text, p_signal uuid, p_checks jsonb, p_usage jsonb default '{}')
returns integer
language plpgsql security definer set search_path = '' as $$
declare g public.radar_signals; x jsonb; v_item uuid; v_check jsonb; i public.radar_items; t public.radar_topics;
 v_closed text; n integer := 0; v_cost numeric; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 select * into g from public.radar_signals where id = p_signal;
 if not found then return 0; end if;
 for x in select * from jsonb_array_elements(case when jsonb_typeof(p_checks) = 'array' then p_checks else '[]' end) loop
  select m.item_id into v_item from public.radar_mentions m
  where m.signal_id = g.id and ((x->>'message_id') ~* '^[0-9a-f-]{36}$' and m.message_id = (x->>'message_id')::uuid
   or jsonb_typeof(x->'at_seconds') = 'number' and m.at_seconds = greatest(round((x->>'at_seconds')::numeric), 0)::integer)
  order by m.created_at desc limit 1;
  continue when v_item is null;
  v_check := mavi_private.agent_check_clean(g.company_id, g.client_id, x->'check');
  continue when v_check is null;
  update public.radar_items set agent_check = v_check where id = v_item returning * into i;
  n := n + 1;
  if (v_check->>'done')::boolean and i.mentions <= 1 and i.status_by is null and i.created_at > now() - interval '1 hour' then
   select * into t from public.radar_topics where id = i.topic_id;
   if i.status = mavi_private.radar_first_status(t.statuses) then
    select coalesce(
     (select s->>'key' from jsonb_array_elements(t.statuses) with ordinality y(s, k)
      where s->>'kind' = 'closed' and coalesce((s->>'reopen')::boolean, false) order by k limit 1),
     (select s->>'key' from jsonb_array_elements(t.statuses) with ordinality y(s, k)
      where s->>'kind' = 'closed' order by k limit 1)) into v_closed;
    if v_closed is not null then
     update public.radar_items set status = v_closed, status_at = now(), updated_at = now() where id = i.id;
    end if;
   end if;
  end if;
 end loop;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 20);
 if v_cost > 0 or coalesce((p_usage->>'input')::integer, 0) > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (g.company_id, null, 'radar', 'radar_agent', g.client_id, left(coalesce(p_usage->>'model', ''), 80),
   greatest(coalesce((p_usage->>'input')::integer, 0), 0), greatest(coalesce((p_usage->>'output')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_read')::integer, 0), 0), greatest(coalesce((p_usage->>'cache_write')::integer, 0), 0),
   v_cost, case when p_usage->>'provider_id' ~* '^[0-9a-f-]{36}$' then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
  update public.radar_signals set cost_usd = cost_usd + v_cost where id = g.id;
 end if;
 return n;
end $$;

-- O que o Radar do cliente mostra além do item (radar_item): quem pode
-- excluir e a conferência com o robô (com quem pode abrir o prompt).
create function public.radar_item_extras(p_company uuid, p_item uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare i public.radar_items; begin
 select * into i from public.radar_items where company_id = p_company and id = p_item;
 if not found or not mavi_private.module_client(p_company, 'radar', i.client_id) then
  raise exception 'Item não encontrado.' using errcode = 'P0002';
 end if;
 return jsonb_strip_nulls(jsonb_build_object('can_remove', mavi_private.leader(p_company),
  'agent_check', i.agent_check,
  'has_agent', exists (select 1 from public.agent_workflows w where w.company_id = p_company and w.client_id = i.client_id
   and w.removed_at is null and not w.ignored and w.role <> 'copy' and not w.archived)));
end $$;

-- ------------------------------------------------------------ produto e base no Radar pessoal
-- Depois da leitura: p_items = [{message_ids: [..], product: nome | null,
-- check}] (as falas identificam o item). O produto só entre os ativos do
-- cliente e só se a pessoa não escolheu; done num item novo e aberto: fecha
-- como "resolvido pela base do robô".
create function public.ai_personal_radar_extras_store(p_secret text, p_group uuid, p_items jsonb,
 p_usage jsonb default '{}') returns integer
language plpgsql security definer set search_path = '' as $$
declare x jsonb; i public.personal_radar_items; v_prod uuid; v_check jsonb; n integer := 0; v_cost numeric;
 v_company uuid; v_client uuid; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
 select company_id, client_id into v_company, v_client from public.whatsapp_groups where id = p_group;
 if v_company is null then return 0; end if;
 for x in select * from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]' end) loop
  select it.* into i from public.personal_radar_items it
  join public.personal_radar_mentions m on m.item_id = it.id
  where it.group_id = p_group
   and m.message_id::text in (select jsonb_array_elements_text(case when jsonb_typeof(x->'message_ids') = 'array'
    then x->'message_ids' else '[]' end))
  order by it.updated_at desc limit 1;
  continue when i.id is null;
  v_prod := null;
  if not i.product_person and coalesce(btrim(x->>'product'), '') <> '' then
   select pr.id into v_prod from public.contracts k join public.products pr on pr.company_id = k.company_id and pr.id = k.product_id
   where k.company_id = i.company_id and k.client_id = i.client_id and not k.archived
    and lower(btrim(pr.name)) = lower(btrim(x->>'product')) limit 1;
  end if;
  v_check := case when x ? 'check' then mavi_private.agent_check_clean(i.company_id, i.client_id, x->'check') end;
  update public.personal_radar_items set
   product_id = case when product_person then product_id else coalesce(v_prod, product_id) end,
   agent_check = coalesce(v_check, agent_check)
  where id = i.id;
  if (v_check->>'done')::boolean and i.status = 'open' and i.asks <= 1 and i.reopened_at is null
   and i.created_at > now() - interval '1 hour' then
   update public.personal_radar_items set status = 'resolved', resolved_at = now(), resolved_how = 'knowledge',
    resolved_by = null, resolved_by_name = 'base do Agente Conversacional', updated_at = now()
   where id = i.id;
  end if;
  n := n + 1;
  i := null;
 end loop;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 20);
 if v_cost > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens, cost_usd,
   provider_id, provider_name)
  values (v_company, null, 'personal_radar', 'agent_check', v_client, left(coalesce(p_usage->>'model', ''), 80),
   greatest(coalesce((p_usage->>'input')::integer, 0), 0), greatest(coalesce((p_usage->>'output')::integer, 0), 0), v_cost,
   case when p_usage->>'provider_id' ~* '^[0-9a-f-]{36}$' then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 return n;
end $$;

-- A pessoa escolhe o produto da situação (nulo: Geral / Agência).
create function public.personal_radar_set_product(p_company uuid, p_item uuid, p_product uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; begin
 if not exists (select 1 from public.personal_radar_owners where company_id = p_company and item_id = p_item and user_id = v_me)
  or not mavi_private.member(p_company) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 select * into i from public.personal_radar_items where id = p_item for update;
 if p_product is not null and not exists (select 1 from public.contracts k where k.company_id = p_company
  and k.client_id = i.client_id and k.product_id = p_product and not k.archived) then
  raise exception 'O cliente não contrata este produto.' using errcode = '22023';
 end if;
 update public.personal_radar_items set product_id = p_product, product_person = true, updated_at = now()
 where id = p_item returning * into i;
 return mavi_private.personal_radar_item_json(i, v_me);
end $$;

-- A da migração 20270306090000, com o produto (e os do cliente, para trocar)
-- e a conferência com o robô.
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
   from public.personal_radar_replies r where r.item_id = i.id and r.user_id = p_user),
  'product', (select jsonb_build_object('id', pr.id, 'name', pr.name) from public.products pr where pr.id = i.product_id),
  'product_person', case when i.product_person then true end,
  'products', (select jsonb_agg(distinct jsonb_build_object('id', pr.id, 'name', pr.name)) from public.contracts k
   join public.products pr on pr.company_id = k.company_id and pr.id = k.product_id
   where k.company_id = i.company_id and k.client_id = i.client_id and not k.archived),
  'agent_check', i.agent_check))
 from public.personal_radar_owners o where o.item_id = i.id and o.user_id = p_user
$$;
revoke all on function mavi_private.personal_radar_item_json(public.personal_radar_items, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ respostas menos repetidas
-- Os exemplos para a resposta de um item: as respostas que a pessoa mandou
-- mais parecidas com a situação (mesmo tipo, cliente e produto primeiro) e
-- as aprovadas de outras pessoas no mesmo produto (referência de conteúdo).
create function public.personal_radar_reply_examples(p_company uuid, p_item uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); i public.personal_radar_items; begin
 if not exists (select 1 from public.personal_radar_owners where company_id = p_company and item_id = p_item and user_id = v_me)
  or not mavi_private.member(p_company) then
  raise exception 'Item não encontrado' using errcode = 'P0002';
 end if;
 select * into i from public.personal_radar_items where id = p_item;
 return jsonb_build_object(
  'product', (select pr.name from public.products pr where pr.id = i.product_id),
  'product_id', i.product_id,
  'mine', (select coalesce(jsonb_agg(x.final order by x.score desc, x.created_at desc), '[]') from (
   select left(f.snapshot->>'final', 1200) as final, f.created_at,
    (case when it.kind = i.kind then 2 else 0 end) + (case when it.client_id = i.client_id then 2 else 0 end)
     + (case when i.product_id is not null and it.product_id = i.product_id then 2 else 0 end) as score
   from public.personal_radar_feedback f
   left join public.personal_radar_items it on it.id = f.item_id
   where f.company_id = p_company and f.user_id = v_me and f.action in ('approved', 'edited')
    and coalesce(f.snapshot->>'final', '') <> '' and f.item_id is distinct from i.id
    and f.created_at > now() - interval '180 days'
   order by score desc, f.created_at desc limit 4) x),
  'team', case when i.product_id is null then '[]' else (select coalesce(jsonb_agg(x.final order by x.score desc, x.created_at desc), '[]') from (
   select left(f.snapshot->>'final', 1200) as final, f.created_at,
    (case when it.kind = i.kind then 1 else 0 end) as score
   from public.personal_radar_feedback f
   join public.personal_radar_items it on it.id = f.item_id
   where f.company_id = p_company and f.user_id <> v_me and f.action in ('approved', 'edited')
    and it.product_id = i.product_id and it.id <> i.id and coalesce(f.snapshot->>'final', '') <> ''
    and f.created_at > now() - interval '120 days'
   order by score desc, f.created_at desc limit 3) x) end);
end $$;

-- ------------------------------------------------------------ lições por produto
alter table public.personal_radar_lessons add column product_id uuid;
alter table public.personal_radar_lessons add constraint personal_radar_lessons_product
 foreign key (company_id, product_id) references public.products(company_id, id) on delete cascade;
alter table public.personal_radar_lessons drop constraint personal_radar_lessons_scope_check;
alter table public.personal_radar_lessons add constraint personal_radar_lessons_scope_check
 check (scope in ('person', 'team', 'client', 'product'));
alter table public.personal_radar_lessons add constraint personal_radar_lessons_product_check
 check (scope <> 'product' or product_id is not null);
-- 'suggested': a MAVI sugeriu, o Jev conferiu e espera um líder aprovar.
alter table public.personal_radar_lessons drop constraint personal_radar_lessons_status_check;
alter table public.personal_radar_lessons add constraint personal_radar_lessons_status_check
 check (status in ('active', 'paused', 'dismissed', 'checking', 'refused', 'suggested'));
create index personal_radar_lessons_product on public.personal_radar_lessons(company_id, product_id) where scope = 'product';

-- As lições em uso para uma pessoa, com as do produto: as do produto do item
-- (p_product) ou, sem ele, as dos produtos ativos do cliente.
create function mavi_private.personal_radar_lessons_for(c uuid, u uuid, p_client uuid, p_kind text, p_product uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('scope', l.scope, 'text', l.text) order by l.o, l.updated_at desc), '[]')
 from (select l.*, case l.scope when 'person' then 0 when 'client' then 1 when 'product' then 2 else 3 end as o
  from public.personal_radar_lessons l
  where l.company_id = c and l.kind = p_kind and l.status = 'active'
   and ((l.scope = 'person' and l.user_id = u)
    or (l.scope = 'team' and l.team_id in (select tm.team_id from public.team_members tm where tm.company_id = c and tm.user_id = u))
    or (l.scope = 'client' and p_client is not null and l.client_id = p_client)
    or (l.scope = 'product' and (l.product_id = p_product or (p_product is null and p_client is not null
     and l.product_id in (select k.product_id from public.contracts k where k.company_id = c and k.client_id = p_client
      and not k.archived)))))
  order by o, l.updated_at desc
  limit 30) l
$$;
revoke all on function mavi_private.personal_radar_lessons_for(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;

-- A da migração 20270307090000: segue valendo, agora com as do produto.
create or replace function mavi_private.personal_radar_lessons_for(c uuid, u uuid, p_client uuid, p_kind text) returns jsonb
language sql stable security definer set search_path = '' as $$
 select mavi_private.personal_radar_lessons_for(c, u, p_client, p_kind, null::uuid)
$$;

-- Para a resposta: as lições de quem escreve, no cliente e no produto do item.
drop function public.personal_radar_reply_lessons(uuid, uuid);
create function public.personal_radar_reply_lessons(p_company uuid, p_client uuid, p_product uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return mavi_private.personal_radar_lessons_for(p_company, auth.uid(), p_client, 'reply', p_product);
end $$;

-- A da migração 20270307090000, com o produto.
create or replace function mavi_private.personal_radar_lesson_json(l public.personal_radar_lessons) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_strip_nulls(jsonb_build_object('id', l.id, 'scope', l.scope, 'kind', l.kind, 'text', l.text,
  'status', l.status, 'origin', l.origin, 'check_note', l.check_note, 'checked_at', l.checked_at,
  'updated_at', l.updated_at, 'evidence', cardinality(l.feedback),
  'user', case when l.scope = 'person' then (select jsonb_build_object('id', m.user_id, 'name', m.name)
   from public.memberships m where m.company_id = l.company_id and m.user_id = l.user_id) end,
  'team', case when l.scope = 'team' then (select jsonb_build_object('id', t.id, 'name', t.name)
   from public.teams t where t.company_id = l.company_id and t.id = l.team_id) end,
  'client', case when l.scope = 'client' then (select jsonb_build_object('id', k.id, 'name', k.name)
   from public.clients k where k.company_id = l.company_id and k.id = l.client_id) end,
  'product', case when l.scope = 'product' then (select jsonb_build_object('id', p.id, 'name', p.name)
   from public.products p where p.company_id = l.company_id and p.id = l.product_id) end,
  'promoted', (select jsonb_agg(jsonb_build_object('scope', y.scope, 'status', y.status)) from public.personal_radar_lessons y
   where y.source_lesson = l.id)))
$$;

-- A fila do aprendizado por produto: suja a cada retorno de resposta numa
-- situação com produto.
create table public.personal_radar_product_learning (
 company_id uuid not null,
 product_id uuid not null,
 dirty_at timestamptz not null default now(),
 claimed_until timestamptz,
 attempts integer not null default 0,
 last_error text,
 learned_at timestamptz,
 primary key (company_id, product_id),
 foreign key (company_id, product_id) references public.products(company_id, id) on delete cascade
);
alter table public.personal_radar_product_learning enable row level security;
revoke all on public.personal_radar_product_learning from public, anon, authenticated;

create function mavi_private.personal_radar_product_dirty() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 insert into public.personal_radar_product_learning as q (company_id, product_id, dirty_at)
 select distinct n.company_id, it.product_id, now() from new_rows n
 join public.personal_radar_items it on it.id = n.item_id
 where it.product_id is not null and n.action in ('approved', 'edited', 'rejected', 'training')
 on conflict (company_id, product_id) do update set dirty_at = now();
 return null;
end $$;
create trigger personal_radar_product_dirty after insert on public.personal_radar_feedback
 referencing new table as new_rows for each statement execute function mavi_private.personal_radar_product_dirty();

-- Os retornos novos de um produto (desde o último aprendizado) que pedem uma
-- rodada: 5 ou mais, ou 2 ou mais com o mais antigo parado há 6 horas.
create function mavi_private.personal_radar_product_due(q public.personal_radar_product_learning) returns boolean
language sql stable security definer set search_path = '' as $$
 select (q.claimed_until is null or q.claimed_until < now()) and q.attempts < 5
  and (q.learned_at is null or q.dirty_at > q.learned_at)
  and (select count(*) >= 5 or (count(*) >= 2 and min(f.created_at) < now() - interval '6 hours')
   from public.personal_radar_feedback f join public.personal_radar_items it on it.id = f.item_id
   where f.company_id = q.company_id and it.product_id = q.product_id
    and f.action in ('approved', 'edited', 'rejected', 'training')
    and (q.learned_at is null or f.created_at > q.learned_at))
$$;
revoke all on function mavi_private.personal_radar_product_due(public.personal_radar_product_learning) from public, anon, authenticated;

-- Um produto para aprender, reservado por 10 minutos: os retornos novos de
-- todas as pessoas (até 40, sem nomes) e as lições do produto.
create function public.ai_personal_radar_product_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.personal_radar_product_learning; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select q.* into l from public.personal_radar_product_learning q
 where mavi_private.personal_radar_product_due(q)
 order by q.dirty_at limit 1 for update skip locked;
 if not found then return null; end if;
 update public.personal_radar_product_learning set claimed_until = now() + interval '10 minutes', attempts = attempts + 1
 where company_id = l.company_id and product_id = l.product_id;
 return jsonb_build_object('company', l.company_id, 'product', l.product_id,
  'product_name', (select p.name from public.products p where p.id = l.product_id),
  'clients', (select count(distinct k.client_id) from public.contracts k where k.company_id = l.company_id
   and k.product_id = l.product_id and not k.archived),
  'feedback', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', f.id, 'action', f.action,
    'note', nullif(f.note, ''), 'kind', it.kind, 'title', it.title, 'summary', left(it.summary, 300),
    'reason', f.snapshot->>'reason', 'draft', left(f.snapshot->>'draft', 800), 'final', left(f.snapshot->>'final', 800),
    'at', to_char(f.created_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'))) order by f.created_at), '[]')
   from (select z.* from public.personal_radar_feedback z join public.personal_radar_items y on y.id = z.item_id
    where z.company_id = l.company_id and y.product_id = l.product_id
     and z.action in ('approved', 'edited', 'rejected', 'training')
     and (l.learned_at is null or z.created_at > l.learned_at)
    order by z.created_at desc limit 40) f
   join public.personal_radar_items it on it.id = f.item_id),
  'lessons', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'text', x.text,
    'status', x.status, 'origin', x.origin) order by x.created_at), '[]')
   from public.personal_radar_lessons x where x.company_id = l.company_id and x.scope = 'product'
    and x.product_id = l.product_id));
end $$;

-- As sugestões: p_ops = [{op: add | update, id?, kind, text, feedback?}].
-- add: nova, para o Jev conferir (depois um líder aprova); update: só uma
-- sugestão da MAVI que ainda não foi aprovada. Nada repete o que já existe
-- (nem o que foi recusado ou excluído).
create function public.ai_personal_radar_product_store(p_secret text, p_company uuid, p_product uuid, p_ops jsonb,
 p_usage jsonb default '{}') returns integer
language plpgsql security definer set search_path = '' as $$
declare o jsonb; n integer := 0; v_text text; v_kind text; v_id uuid; v_fb uuid[]; v_cost numeric; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_text := left(btrim(coalesce(o->>'text', '')), 400);
  v_kind := case when o->>'kind' in ('detection', 'reply') then o->>'kind' end;
  v_id := case when coalesce(o->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (o->>'id')::uuid end;
  select coalesce(array_agg(f.id), '{}') into v_fb from public.personal_radar_feedback f
  where f.company_id = p_company
   and f.id::text in (select jsonb_array_elements_text(case when jsonb_typeof(o->'feedback') = 'array' then o->'feedback' else '[]' end));
  continue when length(v_text) < 5 or exists (select 1 from public.personal_radar_lessons x where x.company_id = p_company
   and x.scope = 'product' and x.product_id = p_product and lower(x.text) = lower(v_text));
  if o->>'op' = 'add' and v_kind is not null then
   insert into public.personal_radar_lessons(company_id, scope, product_id, kind, text, status, origin, feedback)
   values (p_company, 'product', p_product, v_kind, v_text, 'checking', 'mavi', v_fb);
   n := n + 1;
  elsif o->>'op' = 'update' and v_id is not null then
   update public.personal_radar_lessons set text = v_text, kind = coalesce(v_kind, kind), status = 'checking',
    check_attempts = 0, check_note = null, feedback = (select array(select distinct unnest(feedback || v_fb))), updated_at = now()
   where id = v_id and company_id = p_company and scope = 'product' and product_id = p_product
    and origin = 'mavi' and status in ('suggested', 'checking');
   n := n + case when found then 1 else 0 end;
  end if;
 end loop;
 update public.personal_radar_product_learning set learned_at = now(), claimed_until = null, attempts = 0, last_error = null
 where company_id = p_company and product_id = p_product;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 if v_cost > 0 or coalesce((p_usage->>'input')::integer, 0) > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (p_company, null, 'personal_radar', 'product_learning', left(coalesce(p_usage->>'model', ''), 80),
   coalesce((p_usage->>'input')::integer, 0), coalesce((p_usage->>'output')::integer, 0),
   coalesce((p_usage->>'cache_read')::integer, 0), coalesce((p_usage->>'cache_write')::integer, 0), v_cost,
   case when (p_usage->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 return n;
end $$;

create function public.ai_personal_radar_product_fail(p_secret text, p_company uuid, p_product uuid, p_error text)
returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.personal_radar_product_learning set claimed_until = now() + make_interval(mins => attempts * 10),
  last_error = left(p_error, 500)
 where company_id = p_company and product_id = p_product;
end $$;

-- A da migração 20270307090000, com o produto como alvo.
create or replace function public.ai_personal_radar_check_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x public.personal_radar_lessons; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select l.* into x from public.personal_radar_lessons l
 where l.status = 'checking' and l.check_attempts < 3 and (l.check_claimed_until is null or l.check_claimed_until < now())
 order by l.updated_at limit 1 for update skip locked;
 if not found then return null; end if;
 update public.personal_radar_lessons set check_claimed_until = now() + interval '5 minutes', check_attempts = check_attempts + 1
 where id = x.id;
 return jsonb_build_object('id', x.id, 'company', x.company_id, 'scope', x.scope, 'kind', x.kind, 'text', x.text,
  'target', case x.scope when 'team' then (select name from public.teams where company_id = x.company_id and id = x.team_id)
   when 'product' then (select name from public.products where company_id = x.company_id and id = x.product_id)
   else (select name from public.clients where company_id = x.company_id and id = x.client_id) end,
  'others', (select coalesce(jsonb_agg(o.text), '[]') from public.personal_radar_lessons o
   where o.company_id = x.company_id and o.id <> x.id and o.scope = x.scope and o.kind = x.kind and o.status = 'active'
    and o.team_id is not distinct from x.team_id and o.client_id is not distinct from x.client_id
    and o.product_id is not distinct from x.product_id),
  'jev', mavi_private.personal_radar_jev_route(x.company_id));
end $$;

-- A da migração 20270307090000: a sugestão da MAVI num produto, aprovada
-- pelo Jev, ainda espera um líder ('suggested').
create or replace function public.ai_personal_radar_check_store(p_secret text, p_lesson uuid, p_ok boolean, p_note text default null,
 p_usage jsonb default '{}') returns void
language plpgsql security definer set search_path = '' as $$
declare x public.personal_radar_lessons; v_cost numeric; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.personal_radar_lessons set status = case when not p_ok then 'refused'
   when scope = 'product' and origin = 'mavi' then 'suggested' else 'active' end,
  check_note = left(p_note, 500), checked_at = now(), check_claimed_until = null, updated_at = now()
 where id = p_lesson and status = 'checking'
 returning * into x;
 if x.id is null then return; end if;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 if v_cost > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, cost_usd, provider_id, provider_name)
  values (x.company_id, null, 'personal_radar', 'lesson_check', left(coalesce(p_usage->>'model', ''), 80),
   coalesce((p_usage->>'input')::integer, 0), v_cost,
   case when (p_usage->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 perform mavi_private.broadcast(x.company_id, jsonb_build_object('kind', 'personal_radar', 'people',
  case when x.created_by is null then '[]'::jsonb else jsonb_build_array(x.created_by) end, 'lessons', true));
end $$;

-- A da migração 20270309090000: também acorda pelo aprendizado por produto.
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
     and i.status = 'open' and i.updated_at > q.consolidated_at)))
  and not exists (select 1 from public.personal_radar_product_learning q where mavi_private.personal_radar_product_due(q)) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-personal-radar"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 290000);
end $$;

-- A tela (Radar pessoal › Aprendizados › Por produto): líderes veem todos os
-- produtos com as lições (sugestões primeiro); os demais, só as em uso dos
-- produtos dos clientes que atendem.
create function public.personal_radar_product_lessons(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_leader boolean := mavi_private.leader(p_company); begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object('can_edit', v_leader,
  'products', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name,
    'suggested', (select count(*) from public.personal_radar_lessons l where l.company_id = p_company
     and l.scope = 'product' and l.product_id = p.id and l.status = 'suggested'),
    'lessons', (select coalesce(jsonb_agg(mavi_private.personal_radar_lesson_json(l)
      order by l.status = 'suggested' desc, l.status = 'dismissed', l.kind, l.updated_at desc), '[]')
     from public.personal_radar_lessons l where l.company_id = p_company and l.scope = 'product' and l.product_id = p.id
      and (v_leader or l.status = 'active')))
    order by p.name), '[]')
   from public.products p where p.company_id = p_company
    and (v_leader or p.id in (select k.product_id from public.contracts k where k.company_id = p_company and not k.archived
     and k.client_id = any(mavi_private.served_clients_of(p_company, v_me))))));
end $$;

-- Escrever ou editar uma lição do produto (líderes; vale na hora). Editar uma
-- sugestão não a aprova: aprovar é pôr em uso.
create function public.save_personal_radar_product_lesson(p_company uuid, p_id uuid, p_product uuid, p_kind text,
 p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); l public.personal_radar_lessons; v_text text := btrim(coalesce(p_text, '')); begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores mexem nas lições do produto.' using errcode = '42501';
 end if;
 if length(v_text) not between 5 and 400 then
  raise exception 'Escreva a lição com 5 a 400 caracteres.' using errcode = '22023';
 end if;
 if coalesce(p_kind, '') not in ('detection', 'reply') then raise exception 'Tipo inválido' using errcode = '22023'; end if;
 if p_id is null then
  if not exists (select 1 from public.products where company_id = p_company and id = p_product) then
   raise exception 'Produto não encontrado' using errcode = 'P0002';
  end if;
  insert into public.personal_radar_lessons(company_id, scope, product_id, kind, text, status, origin, created_by, updated_by)
  values (p_company, 'product', p_product, p_kind, v_text, 'active', 'leader', v_me, v_me) returning * into l;
 else
  update public.personal_radar_lessons set text = v_text, kind = p_kind, updated_by = v_me, updated_at = now(),
   origin = case when status = 'suggested' then origin else 'leader' end
  where id = p_id and company_id = p_company and scope = 'product' returning * into l;
  if l.id is null then raise exception 'Lição não encontrada' using errcode = 'P0002'; end if;
 end if;
 return mavi_private.personal_radar_lesson_json(l);
end $$;

-- Aprovar (active), pausar ou recusar/excluir (dismissed): líderes.
create function public.set_personal_radar_product_lesson(p_company uuid, p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); l public.personal_radar_lessons; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores mexem nas lições do produto.' using errcode = '42501';
 end if;
 if coalesce(p_status, '') not in ('active', 'paused', 'dismissed') then
  raise exception 'Situação inválida' using errcode = '22023';
 end if;
 update public.personal_radar_lessons set status = p_status,
  check_note = case when status in ('suggested', 'refused') and p_status = 'active'
   then 'Aprovada por ' || coalesce((select name from public.memberships where company_id = p_company and user_id = v_me), 'um líder') || '.'
   else check_note end,
  updated_by = v_me, updated_at = now()
 where id = p_id and company_id = p_company and scope = 'product' returning * into l;
 if l.id is null then raise exception 'Lição não encontrada' using errcode = 'P0002'; end if;
 return mavi_private.personal_radar_lesson_json(l);
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function public.remove_radar_item(uuid, uuid, text, text), public.personal_radar_remove(uuid, uuid, text, text),
 public.agent_knowledge(uuid, uuid, text, integer), public.radar_item_extras(uuid, uuid),
 public.personal_radar_set_product(uuid, uuid, uuid), public.personal_radar_reply_examples(uuid, uuid),
 public.personal_radar_reply_lessons(uuid, uuid, uuid), public.personal_radar_product_lessons(uuid),
 public.save_personal_radar_product_lesson(uuid, uuid, uuid, text, text),
 public.set_personal_radar_product_lesson(uuid, uuid, text) from public, anon;
grant execute on function public.remove_radar_item(uuid, uuid, text, text), public.personal_radar_remove(uuid, uuid, text, text),
 public.agent_knowledge(uuid, uuid, text, integer), public.radar_item_extras(uuid, uuid),
 public.personal_radar_set_product(uuid, uuid, uuid), public.personal_radar_reply_examples(uuid, uuid),
 public.personal_radar_reply_lessons(uuid, uuid, uuid), public.personal_radar_product_lessons(uuid),
 public.save_personal_radar_product_lesson(uuid, uuid, uuid, text, text),
 public.set_personal_radar_product_lesson(uuid, uuid, text) to authenticated;

-- O worker chama como anônimo com o segredo.
revoke all on function public.radar_removed_for_worker(text, uuid), public.agent_knowledge_for_worker(text, uuid, uuid, text, integer),
 public.ai_radar_agent_store(text, uuid, jsonb, jsonb), public.ai_personal_radar_extras_store(text, uuid, jsonb, jsonb),
 public.ai_personal_radar_product_claim(text), public.ai_personal_radar_product_store(text, uuid, uuid, jsonb, jsonb),
 public.ai_personal_radar_product_fail(text, uuid, uuid, text) from public;
grant execute on function public.radar_removed_for_worker(text, uuid), public.agent_knowledge_for_worker(text, uuid, uuid, text, integer),
 public.ai_radar_agent_store(text, uuid, jsonb, jsonb), public.ai_personal_radar_extras_store(text, uuid, jsonb, jsonb),
 public.ai_personal_radar_product_claim(text), public.ai_personal_radar_product_store(text, uuid, uuid, jsonb, jsonb),
 public.ai_personal_radar_product_fail(text, uuid, uuid, text) to anon, authenticated;

commit;
