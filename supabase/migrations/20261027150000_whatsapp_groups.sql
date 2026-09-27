begin;

-- Drive › cliente › "Whatsapp": o arquivo dos grupos de WhatsApp de cada
-- cliente, trazidos da Uazapi (número da agência conectado lá).
--
-- Como os dados chegam (api/_whatsapp.ts, sem service key: o servidor fala
-- com o banco como anon + o segredo de mavi_private.whatsapp_config):
--  1. a cada 2 horas, a varredura lê a lista de grupos da Uazapi (título e
--     horário da última mensagem) e grava em whatsapp_groups. Cada grupo é
--     ligado sozinho ao cliente cujo código aparece no título ("2745 -
--     Facilita & Make" → cliente "2745") e aos produtos do cliente citados no
--     título; um admin pode ligar, corrigir ou ignorar (linked_by = 'manual'
--     não é mais mexido pela varredura);
--  2. os grupos ligados com mensagem nova desde a última leitura são lidos
--     (/message/find) a partir de onde pararam — na primeira vez, os últimos
--     whatsapp_config.backfill_days dias (a Uazapi só guarda 7);
--  3. cada mídia entra numa fila e é copiada para o GCS (a Uazapi apaga as
--     mídias em 2 dias). O caminho nunca sai para o navegador.
-- Grupos sem cliente (internos) não têm mensagens guardadas.
--
-- Leitura: as mensagens seguem a regra do Drive pelo cliente do grupo; a
-- lista de grupos também aparece inteira para admins e gestores (tela de
-- ajuste). Religar um grupo leva junto todas as mensagens dele.
--
-- Configuração (uma vez, fora do git):
--   insert into mavi_private.whatsapp_config(company_id, url, secret)
--   values ('<empresa>', 'https://<app>/api/whatsapp', '<WHATSAPP_WORKER_SECRET>');
-- e supabase/operations/schedule-whatsapp-sync.sql para o agendamento.

create table mavi_private.whatsapp_config (
 id boolean primary key default true check (id),
 company_id uuid not null references public.companies(id),
 url text not null check (url ~ '^https://'),
 secret text not null check (length(secret) >= 32),
 backfill_days integer not null default 8 check (backfill_days between 1 and 30),
 sweep_hours integer not null default 2 check (sweep_hours between 1 and 24),
 last_sweep_at timestamptz,
 last_sweep_error text,
 last_run_at timestamptz
);
alter table mavi_private.whatsapp_config enable row level security;
revoke all on mavi_private.whatsapp_config from public, anon, authenticated;

-- A empresa do número, quando o segredo confere.
create function mavi_private.whatsapp_company(p_secret text) returns uuid
language sql stable security definer set search_path = '' as $$
 select company_id from mavi_private.whatsapp_config where id and p_secret is not null and secret = p_secret
$$;
revoke all on function mavi_private.whatsapp_company(text) from public, anon, authenticated;

-- ------------------------------------------------------------ tabelas
create table public.whatsapp_groups (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 jid text not null check (jid ~ '@g\.us$'),
 title text not null default '' check (length(title) <= 300),
 client_id uuid,
 -- Produtos do cliente de que o grupo trata; vazio = o cliente todo.
 product_ids uuid[] not null default '{}',
 linked_by text not null default 'auto' check (linked_by in ('auto', 'manual')),
 ignored boolean not null default false,
 last_message_at timestamptz,
 -- Até onde as mensagens já foram lidas (a mais recente guardada).
 synced_until timestamptz,
 synced_at timestamptz,
 sync_claimed_at timestamptz,
 sync_error text,
 message_count integer not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(company_id, id),
 unique(company_id, jid),
 foreign key(company_id, client_id) references public.clients(company_id, id)
);
create index whatsapp_groups_client on public.whatsapp_groups(company_id, client_id) where client_id is not null;
-- Grupos com leitura pendente (a varredura olha só estes).
create index whatsapp_groups_pending on public.whatsapp_groups(company_id, last_message_at)
 where client_id is not null and not ignored;
alter table public.whatsapp_groups enable row level security;
revoke all on public.whatsapp_groups from public, anon, authenticated;
grant select (id, company_id, jid, title, client_id, product_ids, linked_by, ignored, last_message_at,
 synced_until, synced_at, sync_error, message_count, created_at, updated_at) on public.whatsapp_groups to authenticated;
create policy whatsapp_groups_read on public.whatsapp_groups for select to authenticated using (
 company_id in (select mavi_private.leader_companies())
 or (company_id in (select mavi_private.active_companies()) and client_id is not null and not ignored
  and mavi_private.drive_can_read(company_id, client_id))
);

create table public.whatsapp_messages (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 group_id uuid not null,
 -- ID da mensagem no WhatsApp (único no grupo) e o ID da Uazapi (download).
 wa_id text not null check (length(wa_id) between 1 and 200),
 source_id text not null default '',
 sent_at timestamptz not null,
 sender text not null default '',
 sender_phone text not null default '',
 sender_name text not null default '',
 from_me boolean not null default false,
 kind text not null check (kind in ('text', 'image', 'video', 'audio', 'document', 'sticker',
  'reaction', 'album', 'poll', 'location', 'contact', 'unavailable', 'other')),
 body text not null default '' check (length(body) <= 65536),
 quoted_wa_id text,
 reaction_to text,
 edited boolean not null default false,
 -- Enquete, localização, contato: o essencial em JSON.
 extra jsonb not null default '{}' check (jsonb_typeof(extra) = 'object'),
 media_mime text,
 media_name text,
 media_bytes bigint,
 media_seconds integer,
 media_status text not null default 'none' check (media_status in ('none', 'pending', 'stored', 'failed', 'lost', 'too_large')),
 media_bucket text,
 media_path text,
 media_attempts integer not null default 0,
 media_claimed_at timestamptz,
 media_error text,
 -- Transcrição do áudio / texto do documento (lidos depois, para a MAVI).
 content_text text,
 search tsvector generated always as (
  to_tsvector('portuguese'::regconfig, left(coalesce(body, '') || ' ' || coalesce(media_name, ''), 100000))
 ) stored,
 created_at timestamptz not null default now(),
 unique(company_id, id),
 unique(company_id, group_id, wa_id),
 foreign key(company_id, group_id) references public.whatsapp_groups(company_id, id) on delete cascade,
 check ((media_bucket is null) = (media_path is null))
);
create index whatsapp_messages_group on public.whatsapp_messages(company_id, group_id, sent_at desc);
create index whatsapp_messages_search on public.whatsapp_messages using gin(search);
create index whatsapp_messages_media on public.whatsapp_messages(company_id, group_id, kind, sent_at desc)
 where kind in ('image', 'video', 'audio', 'document');
create index whatsapp_messages_media_queue on public.whatsapp_messages(sent_at)
 where media_status in ('pending', 'failed');
alter table public.whatsapp_messages enable row level security;
revoke all on public.whatsapp_messages from public, anon, authenticated;
-- O caminho da mídia não sai para o navegador.
grant select (id, company_id, group_id, wa_id, sent_at, sender, sender_phone, sender_name, from_me, kind, body,
 quoted_wa_id, reaction_to, edited, extra, media_mime, media_name, media_bytes, media_seconds, media_status,
 content_text, search, created_at) on public.whatsapp_messages to authenticated;
create policy whatsapp_messages_read on public.whatsapp_messages for select to authenticated using (
 exists (select 1 from public.whatsapp_groups g where g.company_id = whatsapp_messages.company_id
  and g.id = whatsapp_messages.group_id and g.client_id is not null and not g.ignored
  and g.company_id in (select mavi_private.active_companies())
  and mavi_private.drive_can_read(g.company_id, g.client_id))
);

-- ------------------------------------------------------------ ligação automática
-- O código do cliente no título: o primeiro número de 3 a 5 dígitos
-- ("(SME) 4316 - Daselis", "#232 Marcos", "(2745) - Facilita").
create function mavi_private.whatsapp_code(p_title text) returns text
language sql immutable set search_path = '' as $$
 select (regexp_match(coalesce(p_title, ''), '(?:^|\D)(\d{3,5})(?!\d)'))[1]
$$;

-- Cliente e produtos que o título indica. O cliente se chama pelo código
-- ("2745") ou começa por ele ("2745 - Facilita"); os produtos são os que o
-- cliente contrata e que o título cita (palavra inteira, sem caixa).
create function mavi_private.whatsapp_match(c uuid, p_title text, out client_id uuid, out product_ids uuid[])
language plpgsql stable security definer set search_path = '' as $$
declare code text := mavi_private.whatsapp_code(p_title); begin
 product_ids := '{}';
 if code is null then return; end if;
 select cl.id into client_id from public.clients cl
  where cl.company_id = c and (cl.name = code or cl.name ~ ('^' || code || '(\D|$)'))
  order by cl.archived, (cl.name = code) desc, cl.created_at limit 1;
 if client_id is null then return; end if;
 select coalesce(array_agg(distinct p.id), '{}') into product_ids
  from public.contracts ct join public.products p on p.company_id = ct.company_id and p.id = ct.product_id
  where ct.company_id = c and ct.client_id = whatsapp_match.client_id
   and p_title ~* ('\m' || regexp_replace(trim(p.name), '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '\M');
end $$;
revoke all on function mavi_private.whatsapp_code(text), mavi_private.whatsapp_match(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------ worker
-- O que há para fazer: varredura vencida, grupos para ler, mídias na fila.
create function public.whatsapp_worker_state(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.whatsapp_config; begin
 select * into cfg from mavi_private.whatsapp_config where id;
 if cfg.company_id is null or mavi_private.whatsapp_company(p_secret) is null then
  raise exception 'Não autorizado' using errcode = '42501';
 end if;
 update mavi_private.whatsapp_config set last_run_at = now() where id;
 return jsonb_build_object(
  'company', cfg.company_id,
  'sweep_due', cfg.last_sweep_at is null or cfg.last_sweep_at < now() - make_interval(hours => cfg.sweep_hours) + interval '2 minutes',
  'backfill_days', cfg.backfill_days);
end $$;

-- A varredura: p_groups = [{jid, title, last_message_at (ms)}], todos os
-- grupos que a Uazapi conhece. Cria os novos e religa os automáticos.
create function public.whatsapp_sweep(p_secret text, p_groups jsonb, p_error text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.whatsapp_company(p_secret); n integer := 0; begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 if p_error is not null then
  update mavi_private.whatsapp_config set last_sweep_error = left(p_error, 2000) where id;
  return 0;
 end if;
 with incoming as (
  select distinct on (g->>'jid') g->>'jid' as jid, left(coalesce(g->>'title', ''), 300) as title,
   case when (g->>'last_message_at') ~ '^\d+$' and (g->>'last_message_at')::bigint > 0
    then to_timestamp((g->>'last_message_at')::bigint / 1000.0) end as last_at
  from jsonb_array_elements(coalesce(p_groups, '[]')) g
  where g->>'jid' ~ '@g\.us$'
 ), upserted as (
  insert into public.whatsapp_groups as w (company_id, jid, title, client_id, product_ids, last_message_at)
  select c, i.jid, i.title, m.client_id, m.product_ids, i.last_at
  from incoming i cross join lateral mavi_private.whatsapp_match(c, i.title) m
  on conflict (company_id, jid) do update set
   title = excluded.title,
   last_message_at = greatest(w.last_message_at, excluded.last_message_at),
   client_id = case when w.linked_by = 'auto' then excluded.client_id else w.client_id end,
   product_ids = case when w.linked_by = 'auto' then excluded.product_ids else w.product_ids end,
   updated_at = case when w.title is distinct from excluded.title
    or (w.linked_by = 'auto' and (w.client_id is distinct from excluded.client_id or w.product_ids is distinct from excluded.product_ids))
    then now() else w.updated_at end
  returning 1
 ) select count(*) into n from upserted;
 update mavi_private.whatsapp_config set last_sweep_at = now(), last_sweep_error = null where id;
 return n;
end $$;

-- Grupos para ler agora (no máximo p_limit), reservados por 5 minutos.
-- since = a partir de quando ler: a última mensagem guardada, ou os últimos
-- backfill_days dias na primeira leitura.
create function public.whatsapp_claim_groups(p_secret text, p_limit integer default 4)
returns table(id uuid, jid text, since timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare c uuid := mavi_private.whatsapp_company(p_secret); days integer; begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 select backfill_days into days from mavi_private.whatsapp_config where id;
 return query
 with picked as (
  select g.id from public.whatsapp_groups g
  where g.company_id = c and g.client_id is not null and not g.ignored
   and (g.synced_until is null or g.last_message_at > g.synced_until)
   and (g.sync_claimed_at is null or g.sync_claimed_at < now() - interval '5 minutes')
  order by g.synced_until nulls first, g.last_message_at desc nulls last
  limit least(greatest(p_limit, 1), 20)
  for update skip locked
 )
 update public.whatsapp_groups g set sync_claimed_at = now()
 from picked where g.id = picked.id
 returning g.id, g.jid, coalesce(g.synced_until, now() - make_interval(days => days));
end $$;

-- Guarda as mensagens lidas de um grupo. p_until: a mais recente vista,
-- quando a leitura chegou até "since" (senão null — o tempo acabou ou deu
-- erro —, e o grupo é lido de novo desde o mesmo ponto; nada duplica).
-- Mensagens editadas atualizam o texto.
create function public.whatsapp_store_messages(p_secret text, p_group uuid, p_messages jsonb,
 p_until timestamptz default null, p_error text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.whatsapp_company(p_secret); n integer := 0; begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 if not exists (select 1 from public.whatsapp_groups g where g.company_id = c and g.id = p_group
  and g.client_id is not null and not g.ignored) then
  update public.whatsapp_groups set sync_claimed_at = null where company_id = c and id = p_group;
  return 0;
 end if;
 with incoming as (
  select distinct on (m->>'wa_id') m from jsonb_array_elements(coalesce(p_messages, '[]')) m
  where coalesce(m->>'wa_id', '') <> '' and (m->>'sent_at') is not null
 ), saved as (
  insert into public.whatsapp_messages as w (company_id, group_id, wa_id, source_id, sent_at, sender, sender_phone,
   sender_name, from_me, kind, body, quoted_wa_id, reaction_to, edited, extra, media_mime, media_name, media_bytes,
   media_seconds, media_status)
  select c, p_group, left(m->>'wa_id', 200), left(coalesce(m->>'source_id', ''), 300), (m->>'sent_at')::timestamptz,
   left(coalesce(m->>'sender', ''), 200), left(coalesce(m->>'sender_phone', ''), 40), left(coalesce(m->>'sender_name', ''), 200),
   coalesce((m->>'from_me')::boolean, false), m->>'kind', left(coalesce(m->>'body', ''), 65536),
   nullif(m->>'quoted_wa_id', ''), nullif(m->>'reaction_to', ''), coalesce((m->>'edited')::boolean, false),
   case when jsonb_typeof(m->'extra') = 'object' then m->'extra' else '{}' end,
   nullif(m->>'media_mime', ''), nullif(left(coalesce(m->>'media_name', ''), 300), ''),
   (m->>'media_bytes')::bigint, (m->>'media_seconds')::integer,
   case when m->>'kind' in ('image', 'video', 'audio', 'document', 'sticker') then 'pending' else 'none' end
  from incoming
  on conflict (company_id, group_id, wa_id) do update set
   body = excluded.body, edited = excluded.edited, source_id = excluded.source_id
  where w.body is distinct from excluded.body or w.edited is distinct from excluded.edited
  returning (xmax = 0) as inserted
 ) select count(*) filter (where inserted) into n from saved;
 -- Leitura completa: o grupo fica em dia até a última mensagem que a
  -- varredura viu (mesmo que seja de um tipo que não se guarda), para não ser
  -- lido de novo sem necessidade.
 update public.whatsapp_groups g set
  message_count = g.message_count + n,
  synced_until = case when p_until is not null
   then greatest(g.synced_until, p_until, g.last_message_at) else g.synced_until end,
  synced_at = case when p_error is null then now() else g.synced_at end,
  sync_error = left(p_error, 1000),
  sync_claimed_at = null
 where g.company_id = c and g.id = p_group;
 return n;
end $$;

-- Mídias para copiar (no máximo p_limit), reservadas por 10 minutos. Depois
-- de 5 tentativas, ou quando a Uazapi já não tem mais a mensagem (7 dias),
-- a mídia fica como perdida.
create function public.whatsapp_claim_media(p_secret text, p_limit integer default 6)
returns table(id uuid, source_id text, group_jid text, kind text, media_mime text, media_name text,
 media_bytes bigint, sent_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare c uuid := mavi_private.whatsapp_company(p_secret); begin
 if c is null then raise exception 'Não autorizado' using errcode = '42501'; end if;
 update public.whatsapp_messages m set media_status = 'lost', media_claimed_at = null
 where m.company_id = c and m.media_status in ('pending', 'failed')
  and (m.media_attempts >= 5 or m.sent_at < now() - interval '7 days')
  and (m.media_claimed_at is null or m.media_claimed_at < now() - interval '10 minutes');
 return query
 with picked as (
  select m.id from public.whatsapp_messages m
  join public.whatsapp_groups g on g.company_id = m.company_id and g.id = m.group_id
  where m.company_id = c and m.media_status in ('pending', 'failed')
   and g.client_id is not null and not g.ignored
   and (m.media_claimed_at is null or m.media_claimed_at < now() - interval '10 minutes')
  -- As mais antigas primeiro: são as que a Uazapi apaga antes.
  order by m.media_attempts, m.sent_at
  limit least(greatest(p_limit, 1), 20)
  for update of m skip locked
 )
 update public.whatsapp_messages m set media_claimed_at = now(), media_attempts = m.media_attempts + 1
 from picked, public.whatsapp_groups g
 where m.id = picked.id and g.company_id = m.company_id and g.id = m.group_id
 returning m.id, m.source_id, g.jid, m.kind, m.media_mime, m.media_name, m.media_bytes, m.sent_at;
end $$;

-- O resultado da cópia de uma mídia.
create function public.whatsapp_store_media(p_secret text, p_message uuid, p_status text,
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
  media_claimed_at = null
 where company_id = c and id = p_message;
end $$;

-- Chamado pelo pg_cron a cada minuto (supabase/operations/
-- schedule-whatsapp-sync.sql): acorda o servidor só quando a varredura de 2h
-- venceu ou ainda há grupos para ler ou mídias na fila.
create function mavi_private.whatsapp_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.whatsapp_config; begin
 select * into cfg from mavi_private.whatsapp_config where id;
 if not found then return; end if;
 if not (cfg.last_sweep_at is null or cfg.last_sweep_at < now() - make_interval(hours => cfg.sweep_hours) + interval '2 minutes'
  or exists (select 1 from public.whatsapp_groups g where g.company_id = cfg.company_id and g.client_id is not null
   and not g.ignored and (g.synced_until is null or g.last_message_at > g.synced_until)
   and (g.sync_claimed_at is null or g.sync_claimed_at < now() - interval '5 minutes'))
  or exists (select 1 from public.whatsapp_messages m where m.media_status in ('pending', 'failed')
   and m.company_id = cfg.company_id and (m.media_claimed_at is null or m.media_claimed_at < now() - interval '10 minutes')))
 then return; end if;
 -- Uma chamada de cada vez: a anterior ainda pode estar trabalhando.
 if cfg.last_run_at > now() - interval '100 seconds' then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"whatsapp-sync"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.whatsapp_kick() from public, anon, authenticated;

-- ------------------------------------------------------------ tela de ajuste
-- Ligar um grupo a um cliente (e produtos), ignorá-lo ou devolvê-lo à ligação
-- automática (p_auto). Só administradores.
create function public.whatsapp_set_group(p_company uuid, p_group uuid, p_client uuid default null,
 p_products uuid[] default '{}', p_ignored boolean default false, p_auto boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.whatsapp_groups; m record; begin
 if not mavi_private.admin(p_company) then raise exception 'Apenas administradores' using errcode = '42501'; end if;
 select * into g from public.whatsapp_groups where company_id = p_company and id = p_group for update;
 if not found then raise exception 'Grupo não encontrado' using errcode = 'P0002'; end if;
 if p_auto then
  select * into m from mavi_private.whatsapp_match(p_company, g.title);
  update public.whatsapp_groups set linked_by = 'auto', ignored = false, client_id = m.client_id,
   product_ids = m.product_ids, updated_at = now() where id = p_group;
  return;
 end if;
 if p_client is not null and not exists (select 1 from public.clients where company_id = p_company and id = p_client) then
  raise exception 'Cliente não encontrado' using errcode = 'P0002';
 end if;
 if exists (select 1 from unnest(coalesce(p_products, '{}')) p
  where not exists (select 1 from public.products where company_id = p_company and id = p)) then
  raise exception 'Produto não encontrado' using errcode = 'P0002';
 end if;
 update public.whatsapp_groups set linked_by = 'manual', ignored = coalesce(p_ignored, false),
  client_id = p_client, product_ids = case when p_client is null then '{}' else coalesce(p_products, '{}') end,
  updated_at = now()
 where id = p_group;
end $$;

-- Como vai a coleta (tela de ajuste): última varredura, fila e erros.
create function public.whatsapp_status(p_company uuid) returns jsonb
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
   and m.media_status in ('lost', 'too_large')));
end $$;

revoke all on function public.whatsapp_worker_state(text), public.whatsapp_sweep(text, jsonb, text),
 public.whatsapp_claim_groups(text, integer), public.whatsapp_store_messages(text, uuid, jsonb, timestamptz, text),
 public.whatsapp_claim_media(text, integer),
 public.whatsapp_store_media(text, uuid, text, text, text, text, bigint, text),
 public.whatsapp_set_group(uuid, uuid, uuid, uuid[], boolean, boolean), public.whatsapp_status(uuid)
 from public, anon, authenticated;
-- anon: o servidor, com o segredo.
grant execute on function public.whatsapp_worker_state(text), public.whatsapp_sweep(text, jsonb, text),
 public.whatsapp_claim_groups(text, integer), public.whatsapp_store_messages(text, uuid, jsonb, timestamptz, text),
 public.whatsapp_claim_media(text, integer),
 public.whatsapp_store_media(text, uuid, text, text, text, text, bigint, text) to anon, authenticated;
grant execute on function public.whatsapp_set_group(uuid, uuid, uuid, uuid[], boolean, boolean),
 public.whatsapp_status(uuid) to authenticated;

commit;
