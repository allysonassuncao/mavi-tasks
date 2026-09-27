begin;

-- Drive › cliente › Whatsapp (etapa 3): as conversas dos grupos na base de
-- conhecimento da MAVI.
--
-- - Conteúdo das mídias: depois de copiados para o GCS, os áudios são
--   transcritos e os documentos (PDF, Word, PowerPoint, Excel, texto) têm o
--   texto lido pelo worker do Whatsapp (api/_whatsapp.ts), que devolve em
--   whatsapp_messages.content_text. Imagens e vídeos não são lidos: entram só
--   marcados ("[imagem]", "[vídeo]") para a MAVI saber que existem.
-- - Busca: cada grupo vira um documento por dia (horário de Brasília), com as
--   mensagens em ordem ("14:05 Fulano: …") quebradas em trechos de conversa
--   (pausa longa ou tamanho). O texto dos documentos enviados entra em
--   trechos próprios. Cada trecho guarda a primeira mensagem: a citação abre
--   a conversa ali. Acesso: a regra do Drive pelo cliente do grupo.
-- - Mensagens novas, editadas ou transcritas e mudanças no grupo (cliente,
--   produtos, ignorado) refazem só os dias afetados, pela fila da MAVI.

-- ------------------------------------------------------------ conteúdo das mídias
alter table public.whatsapp_messages
 add column content_status text not null default 'none'
  check (content_status in ('none', 'pending', 'done', 'empty', 'skipped', 'error')),
 add column content_attempts integer not null default 0,
 add column content_claimed_at timestamptz;
create index whatsapp_messages_content_queue on public.whatsapp_messages(sent_at)
 where content_status = 'pending';
grant select (content_status) on public.whatsapp_messages to authenticated;

-- O que o worker sabe ler de uma mídia: 'audio' (transcrição) ou o tipo de
-- documento (os mesmos do Drive). Nulo: não se lê.
create function mavi_private.whatsapp_content_kind(p_kind text, p_mime text, p_name text, p_bytes bigint)
returns text
language sql stable set search_path = '' as $$
 select case
  when p_kind = 'audio' and coalesce(p_bytes, 0) <= 24 * 1048576 then 'audio'
  when p_kind = 'document' and coalesce(p_bytes, 0) <= 25 * 1048576
   then mavi_private.ai_file_kind(coalesce(p_mime, ''), coalesce(p_name, ''))
 end
$$;
revoke all on function mavi_private.whatsapp_content_kind(text, text, text, bigint) from public, anon, authenticated;

-- A mídia copiada: áudios e documentos legíveis entram na fila de leitura.
create or replace function public.whatsapp_store_media(p_secret text, p_message uuid, p_status text,
 p_bucket text default null, p_path text default null, p_mime text default null, p_bytes bigint default null,
 p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.whatsapp_company(p_secret); begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 if p_status not in ('stored', 'failed', 'lost', 'too_large') then
  raise exception 'Situação inválida' using errcode = '22023';
 end if;
 update public.whatsapp_messages set
  media_status = p_status,
  media_bucket = case when p_status = 'stored' then p_bucket else media_bucket end,
  media_path = case when p_status = 'stored' then p_path else media_path end,
  media_mime = coalesce(nullif(p_mime, ''), media_mime),
  media_bytes = coalesce(p_bytes, media_bytes),
  media_error = case when p_status = 'stored' then null else left(p_error, 1000) end,
  media_claimed_at = null,
  content_status = case
   when p_status <> 'stored' or kind not in ('audio', 'document') then content_status
   when mavi_private.whatsapp_content_kind(kind, coalesce(nullif(p_mime, ''), media_mime), media_name,
    coalesce(p_bytes, media_bytes)) is null then 'skipped'
   else 'pending' end
 where company_id = c and id = p_message;
end $$;

-- As próximas mídias para ler (reservadas por 10 minutos; até 3 tentativas).
create function public.whatsapp_claim_content(p_secret text, p_limit integer default 4)
returns table(id uuid, kind text, content_kind text, bucket text, path text, media_mime text, media_name text,
 media_bytes bigint, media_seconds integer, client_id uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare c uuid := mavi_private.whatsapp_company(p_secret); begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 return query
 with picked as (
  select m.id from public.whatsapp_messages m
  join public.whatsapp_groups g on g.company_id = m.company_id and g.id = m.group_id
  where m.company_id = c and m.content_status = 'pending' and m.content_attempts < 3
   and g.client_id is not null and not g.ignored
   and (m.content_claimed_at is null or m.content_claimed_at < now() - interval '10 minutes')
  order by m.sent_at desc
  limit least(greatest(p_limit, 1), 20)
  for update of m skip locked
 )
 update public.whatsapp_messages m set content_claimed_at = now(), content_attempts = m.content_attempts + 1
 from picked, public.whatsapp_groups g
 where m.id = picked.id and g.company_id = m.company_id and g.id = m.group_id
 returning m.id, m.kind, mavi_private.whatsapp_content_kind(m.kind, m.media_mime, m.media_name, m.media_bytes),
  m.media_bucket, m.media_path, m.media_mime, m.media_name, m.media_bytes, m.media_seconds, g.client_id;
end $$;

-- O texto lido (transcrição ou documento) ou o motivo de não ter texto. Um
-- erro volta para a fila até a terceira tentativa.
create function public.whatsapp_store_content(p_secret text, p_message uuid, p_status text, p_text text default null,
 p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.whatsapp_company(p_secret); begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 if p_status not in ('done', 'empty', 'skipped', 'error') then
  raise exception 'Situação inválida' using errcode = '22023';
 end if;
 update public.whatsapp_messages set
  content_status = case when p_status = 'error' and content_attempts < 3 then 'pending' else p_status end,
  content_text = case when p_status = 'done' then left(p_text, 400000) else content_text end,
  media_error = case when p_status = 'error' then left(p_error, 1000) else media_error end,
  content_claimed_at = null
 where company_id = c and id = p_message;
end $$;

-- O custo das transcrições (o worker não tem usuário), por cliente.
create function public.whatsapp_log_usage(p_secret text, p_model text, p_items jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.whatsapp_company(p_secret); begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, cost_usd)
 select c, null, 'whatsapp', 'transcribe', cl.id, left(coalesce(p_model, ''), 80),
  least(greatest(coalesce((i->>'cost')::numeric, 0), 0), 100)
 from jsonb_array_elements(coalesce(p_items, '[]')) i
 left join public.clients cl on cl.company_id = c and cl.id = nullif(i->>'client', '')::uuid;
end $$;

-- O servidor também acorda para ler mídias.
create or replace function mavi_private.whatsapp_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.whatsapp_config; begin
 select * into cfg from mavi_private.whatsapp_config where id;
 if not found then return; end if;
 if not (cfg.last_sweep_at is null or cfg.last_sweep_at < now() - make_interval(hours => cfg.sweep_hours) + interval '2 minutes'
  or exists (select 1 from public.whatsapp_groups g where g.company_id = cfg.company_id and g.client_id is not null
   and not g.ignored and (g.synced_until is null or g.last_message_at > g.synced_until)
   and (g.sync_claimed_at is null or g.sync_claimed_at < now() - interval '5 minutes'))
  or exists (select 1 from public.whatsapp_messages m where m.media_status in ('pending', 'failed')
   and m.company_id = cfg.company_id and (m.media_claimed_at is null or m.media_claimed_at < now() - interval '10 minutes'))
  or exists (select 1 from public.whatsapp_messages m where m.content_status = 'pending' and m.content_attempts < 3
   and m.company_id = cfg.company_id and (m.content_claimed_at is null or m.content_claimed_at < now() - interval '10 minutes')))
 then return; end if;
 -- Uma chamada de cada vez: a anterior ainda pode estar trabalhando.
 if cfg.last_run_at > now() - interval '100 seconds' then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"whatsapp-sync"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

create or replace function public.whatsapp_status(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cfg mavi_private.whatsapp_config; begin
 if not mavi_private.leader(p_company) then raise exception 'Apenas administradores e gestores' using errcode = '42501'; end if;
 select * into cfg from mavi_private.whatsapp_config where id and company_id = p_company;
 return jsonb_build_object(
  'configured', cfg.company_id is not null,
  'last_sweep_at', cfg.last_sweep_at,
  'last_sweep_error', cfg.last_sweep_error,
  'sweep_hours', coalesce(cfg.sweep_hours, 2),
  'backfill_days', coalesce(cfg.backfill_days, 8),
  'groups_pending', (select count(*) from public.whatsapp_groups g where g.company_id = p_company
   and g.client_id is not null and not g.ignored and (g.synced_until is null or g.last_message_at > g.synced_until)),
  'groups_with_error', (select count(*) from public.whatsapp_groups g where g.company_id = p_company and g.sync_error is not null),
  'messages', (select coalesce(sum(message_count), 0) from public.whatsapp_groups g where g.company_id = p_company),
  'media_pending', (select count(*) from public.whatsapp_messages m where m.company_id = p_company
   and m.media_status in ('pending', 'failed')),
  'media_lost', (select count(*) from public.whatsapp_messages m where m.company_id = p_company
   and m.media_status in ('lost', 'too_large')),
  'content_pending', (select count(*) from public.whatsapp_messages m where m.company_id = p_company
   and m.content_status = 'pending' and m.content_attempts < 3),
  'content_done', (select count(*) from public.whatsapp_messages m where m.company_id = p_company
   and m.content_status = 'done'));
end $$;

revoke all on function public.whatsapp_claim_content(text, integer),
 public.whatsapp_store_content(text, uuid, text, text, text), public.whatsapp_log_usage(text, text, jsonb)
 from public, anon, authenticated;
grant execute on function public.whatsapp_claim_content(text, integer),
 public.whatsapp_store_content(text, uuid, text, text, text), public.whatsapp_log_usage(text, text, jsonb)
 to anon, authenticated;

-- ------------------------------------------------------------ MAVI: documentos por dia
alter table public.ai_documents drop constraint ai_documents_source_type_check;
alter table public.ai_documents add constraint ai_documents_source_type_check
 check (source_type in ('meeting', 'task', 'drive_file', 'social_plan', 'social_briefing', 'campaign',
  'success_case', 'whatsapp'));

-- Um dia de um grupo: o id é o source_id do documento da MAVI.
create table mavi_private.whatsapp_ai_days (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 group_id uuid not null,
 day date not null,
 unique(group_id, day)
);
revoke all on mavi_private.whatsapp_ai_days from public, anon, authenticated;

-- Os dias (grupo + data) mudados entram na fila da MAVI.
create function mavi_private.whatsapp_ai_touch(p_rows jsonb) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if p_rows is null or jsonb_array_length(p_rows) = 0 then return; end if;
 insert into mavi_private.whatsapp_ai_days(company_id, group_id, day)
 select distinct (x->>'company_id')::uuid, (x->>'group_id')::uuid, (x->>'day')::date
 from jsonb_array_elements(p_rows) x
 on conflict (group_id, day) do nothing;
 perform mavi_private.ai_enqueue('whatsapp', (
  select jsonb_agg(jsonb_build_object('id', d.id, 'company_id', d.company_id))
  from mavi_private.whatsapp_ai_days d
  join (select distinct (x->>'group_id')::uuid as g, (x->>'day')::date as dy from jsonb_array_elements(p_rows) x) k
   on k.g = d.group_id and k.dy = d.day));
end $$;

create function mavi_private.whatsapp_ai_queue() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if tg_op = 'UPDATE' then
  perform mavi_private.whatsapp_ai_touch((select jsonb_agg(jsonb_build_object('company_id', n.company_id,
    'group_id', n.group_id, 'day', (n.sent_at at time zone 'America/Sao_Paulo')::date))
   from new_rows n join old_rows o on o.id = n.id
   where (n.body, n.edited, n.content_text) is distinct from (o.body, o.edited, o.content_text)));
 else
  perform mavi_private.whatsapp_ai_touch((select jsonb_agg(jsonb_build_object('company_id', x.company_id,
    'group_id', x.group_id, 'day', (x.sent_at at time zone 'America/Sao_Paulo')::date)) from changed x));
 end if;
 return null;
end $$;
create trigger whatsapp_ai_messages_ins after insert on public.whatsapp_messages
 referencing new table as changed for each statement execute function mavi_private.whatsapp_ai_queue();
create trigger whatsapp_ai_messages_upd after update on public.whatsapp_messages
 referencing old table as old_rows new table as new_rows for each statement execute function mavi_private.whatsapp_ai_queue();

-- O grupo mudou de cliente, de produtos, de nome ou foi ignorado: todos os
-- dias dele são refeitos (ou saem da busca).
create function mavi_private.whatsapp_ai_group() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.ai_enqueue('whatsapp', (select jsonb_agg(jsonb_build_object('id', d.id, 'company_id', d.company_id))
  from mavi_private.whatsapp_ai_days d where d.group_id = new.id));
 return null;
end $$;
create trigger whatsapp_ai_group after update of client_id, product_ids, ignored, title on public.whatsapp_groups
 for each row when ((old.client_id, old.product_ids, old.ignored, old.title)
  is distinct from (new.client_id, new.product_ids, new.ignored, new.title))
 execute function mavi_private.whatsapp_ai_group();
revoke all on function mavi_private.whatsapp_ai_touch(jsonb), mavi_private.whatsapp_ai_queue(),
 mavi_private.whatsapp_ai_group() from public, anon, authenticated;

-- Quem mandou, como aparece no texto.
create function mavi_private.whatsapp_sender(m public.whatsapp_messages) returns text
language sql immutable set search_path = '' as $$
 select coalesce(nullif(btrim(m.sender_name), ''),
  case when m.from_me then 'Agência' when m.sender_phone <> '' then '+' || m.sender_phone else 'Participante' end)
$$;

-- Uma mensagem como linha de conversa (sem o horário).
create function mavi_private.whatsapp_line(m public.whatsapp_messages) returns text
language sql immutable set search_path = '' as $$
 select btrim(case m.kind
  when 'image' then '[imagem]' || coalesce(' ' || nullif(btrim(m.body), ''), '')
  when 'video' then '[vídeo' || coalesce(' ' || nullif(mavi_private.ai_clock(m.media_seconds), '00:00'), '') || ']'
   || coalesce(' ' || nullif(btrim(m.body), ''), '')
  when 'sticker' then '[figurinha]'
  when 'audio' then '[áudio' || coalesce(' ' || nullif(mavi_private.ai_clock(m.media_seconds), '00:00'), '') || ']'
   || case when m.content_status = 'done' and btrim(coalesce(m.content_text, '')) <> '' then ' ' || btrim(m.content_text)
      when m.content_status = 'pending' then ' (transcrição pendente)'
      else ' (sem transcrição)' end
  when 'document' then format('[documento "%s"]', coalesce(m.media_name, 'arquivo'))
   || coalesce(' ' || nullif(btrim(m.body), ''), '')
  when 'poll' then '[enquete] ' || m.body || coalesce(' — opções: ' || (select string_agg(o, '; ')
    from jsonb_array_elements_text(coalesce(m.extra->'options', '[]')) o), '')
  when 'location' then '[localização] ' || m.body
  when 'contact' then '[contato] ' || m.body
  when 'unavailable' then '[mensagem não disponível]'
  else m.body end)
$$;
revoke all on function mavi_private.whatsapp_sender(public.whatsapp_messages),
 mavi_private.whatsapp_line(public.whatsapp_messages) from public, anon, authenticated;

-- O documento de um dia de um grupo. Trechos de conversa de até ~1.200
-- caracteres, cortados também numa pausa de mais de 45 minutos; o texto dos
-- documentos enviados vem depois, em trechos próprios.
create function mavi_private.ai_build_whatsapp(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; m public.whatsapp_messages; v_from timestamptz; v_to timestamptz; v_contract uuid;
 v_header text; v_pieces jsonb := '[]'; v_docs jsonb := '[]'; buf text := ''; buf_first uuid; buf_start timestamptz;
 v_last timestamptz; v_line text; v_quote text; piece text; v_products text;
begin
 select d.*, g.title, g.client_id, g.product_ids, g.ignored, cl.name as client_name into r
 from mavi_private.whatsapp_ai_days d
 join public.whatsapp_groups g on g.company_id = d.company_id and g.id = d.group_id
 left join public.clients cl on cl.company_id = g.company_id and cl.id = g.client_id
 where d.id = p_id;
 if not found or r.client_id is null or r.ignored then perform mavi_private.ai_forget('whatsapp', p_id); return; end if;
 v_from := r.day::timestamp at time zone 'America/Sao_Paulo';
 v_to := (r.day + 1)::timestamp at time zone 'America/Sao_Paulo';
 -- Grupo de um produto só: o trecho vale também no filtro do produto.
 select case when count(*) = 1 then min(k.id::text)::uuid end into v_contract
 from public.contracts k
 where k.company_id = r.company_id and k.client_id = r.client_id and not k.archived and k.product_id = any(r.product_ids);
 select string_agg(p.name, ', ' order by p.name) into v_products
 from public.products p where p.company_id = r.company_id and p.id = any(r.product_ids);
 v_header := concat_ws(' · ', format('[Whatsapp] grupo "%s"', r.title), 'cliente ' || r.client_name,
  case when v_products is not null then 'produtos ' || v_products end, to_char(r.day, 'DD/MM/YYYY'));
 for m in
  select * from public.whatsapp_messages x
  where x.company_id = r.company_id and x.group_id = r.group_id and x.sent_at >= v_from and x.sent_at < v_to
   and x.kind not in ('reaction', 'album')
  order by x.sent_at, x.id
 loop
  v_quote := null;
  if m.quoted_wa_id is not null then
   select left(regexp_replace(mavi_private.whatsapp_line(q), '\s+', ' ', 'g'), 90) || ' (' || mavi_private.whatsapp_sender(q) || ')'
    into v_quote from public.whatsapp_messages q
    where q.company_id = m.company_id and q.group_id = m.group_id and q.wa_id = m.quoted_wa_id;
  end if;
  v_line := to_char(m.sent_at at time zone 'America/Sao_Paulo', 'HH24:MI') || ' ' || mavi_private.whatsapp_sender(m) || ': '
   || case when v_quote is not null then '(respondendo a "' || v_quote || '") ' else '' end
   || mavi_private.whatsapp_line(m) || case when m.edited then ' (editada)' else '' end;
  if buf <> '' and (length(buf) + length(v_line) > 1200 or m.sent_at - v_last > interval '45 minutes') then
   v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', buf, 'meta', jsonb_build_object(
    'kind', 'whatsapp', 'group', r.group_id, 'message', buf_first, 'at', buf_start)));
   buf := '';
  end if;
  if length(v_line) > 1200 then
   -- Uma mensagem longa (texto ou transcrição) vira trechos próprios.
   for piece in select mavi_private.ai_split(v_line, 1200) loop
    v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', piece, 'meta', jsonb_build_object(
     'kind', 'whatsapp', 'group', r.group_id, 'message', m.id, 'at', m.sent_at)));
   end loop;
  else
   if buf = '' then buf_first := m.id; buf_start := m.sent_at; end if;
   buf := case when buf = '' then v_line else buf || E'\n' || v_line end;
  end if;
  v_last := m.sent_at;
  if m.kind = 'document' and m.content_status = 'done' and btrim(coalesce(m.content_text, '')) <> '' then
   for piece in select mavi_private.ai_split(left(m.content_text, 60000)) loop
    v_docs := v_docs || jsonb_build_array(jsonb_build_object('text',
     format('Documento "%s" enviado por %s às %s:', coalesce(m.media_name, 'arquivo'), mavi_private.whatsapp_sender(m),
      to_char(m.sent_at at time zone 'America/Sao_Paulo', 'HH24:MI')) || E'\n' || piece,
     'meta', jsonb_build_object('kind', 'whatsapp_document', 'group', r.group_id, 'message', m.id, 'at', m.sent_at,
      'label', m.media_name)));
   end loop;
  end if;
 end loop;
 if buf <> '' then
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', buf, 'meta', jsonb_build_object(
   'kind', 'whatsapp', 'group', r.group_id, 'message', buf_first, 'at', buf_start)));
 end if;
 v_pieces := v_pieces || v_docs;
 if jsonb_array_length(v_pieces) = 0 then perform mavi_private.ai_forget('whatsapp', p_id); return; end if;
 perform mavi_private.ai_save_document(r.company_id, 'whatsapp', p_id, 'client', r.client_id, v_contract, null, null,
  format('Whatsapp · %s · %s', r.title, to_char(r.day, 'DD/MM/YYYY')), v_from, v_header, v_pieces);
end $$;
revoke all on function mavi_private.ai_build_whatsapp(uuid) from public, anon, authenticated;

create or replace function mavi_private.ai_build(p_type text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if p_type = 'meeting' then perform mavi_private.ai_build_meeting(p_id);
 elsif p_type = 'task' then perform mavi_private.ai_build_task(p_id);
 elsif p_type = 'drive_file' then perform mavi_private.ai_build_drive_file(p_id);
 elsif p_type = 'social_plan' then perform mavi_private.ai_build_social_plan(p_id);
 elsif p_type = 'social_briefing' then perform mavi_private.ai_build_social_briefing(p_id);
 elsif p_type = 'campaign' then perform mavi_private.ai_build_campaign(p_id);
 elsif p_type = 'success_case' then perform mavi_private.case_index(p_id);
 elsif p_type = 'whatsapp' then perform mavi_private.ai_build_whatsapp(p_id);
 end if;
end $$;
revoke all on function mavi_private.ai_build(text, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ o que já existe
-- Áudios e documentos já copiados entram na fila de leitura; os dias já
-- guardados entram na fila da MAVI (o worker indexa aos poucos).
update public.whatsapp_messages set content_status = case
  when mavi_private.whatsapp_content_kind(kind, media_mime, media_name, media_bytes) is null then 'skipped'
  else 'pending' end
where media_status = 'stored' and kind in ('audio', 'document') and content_status = 'none';
select mavi_private.whatsapp_ai_touch((select jsonb_agg(distinct jsonb_build_object('company_id', company_id,
 'group_id', group_id, 'day', (sent_at at time zone 'America/Sao_Paulo')::date)) from public.whatsapp_messages));

commit;
