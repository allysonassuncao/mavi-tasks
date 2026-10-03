begin;

-- Planejamento › Social Media › Agendamento, fase 2: a publicação automática
-- pelo Meta (Instagram — feed, carrossel, Reels e Stories — e a Página do
-- Facebook).
--
-- - Um app do Meta só do Social Media (SOCIAL_MEDIA_META_APP_ID/_SECRET na
--   Vercel), separado do das Campanhas: os tokens, as tabelas e a escolha de
--   Páginas daqui nunca tocam na conexão das Campanhas/Leads
--   (mavi_private.ad_*). Os tokens são lacrados com SOCIAL_MEDIA_TOKEN_KEY.
-- - Duas formas de conectar cada cliente: pela agência (administrador ou
--   gestor entra com o Facebook e escolhe a Página do cliente) ou pelo link
--   que a equipe manda ao cliente (/conectar/<token>: ele entra com o
--   Facebook dele e escolhe a Página). Fica guardado o token da Página
--   (não expira enquanto quem conectou tiver acesso a ela).
-- - Na hora marcada, com o cliente conectado, o post vai para 'publishing'
--   e o pg_cron acorda o worker (/api/social-media, com o AI_WORKER_SECRET).
--   O worker publica destino por destino, guardando o andamento em
--   meta_state (vídeos esperam o Meta processar e continuam na rodada
--   seguinte). Tudo certo: 'published' pelo Meta, com o link. Algo falhou:
--   volta para 'due' com o motivo e o aviso de sempre (lembrete para
--   publicar à mão o que faltou). Token inválido: a conexão fica marcada
--   com o erro e a equipe é avisada.
-- - Sem conexão, tudo segue como na fase 1 (lembrete).

-- ------------------------------------------------------------ conexão
alter table public.social_media_accounts
 add column page_id text check (page_id is null or page_id ~ '^[0-9]{1,30}$'),
 add column page_name text,
 add column ig_user_id text check (ig_user_id is null or ig_user_id ~ '^[0-9]{1,30}$'),
 add column ig_username text,
 add column connected_via text check (connected_via in ('agency', 'client')),
 -- Quem entrou com o Facebook (o nome do perfil, também no link do cliente).
 add column connected_name text,
 add column connected_by uuid,
 add column connected_at timestamptz,
 add column connection_error text check (connection_error is null or length(connection_error) <= 500),
 add column connection_error_at timestamptz;

-- O token da Página (lacrado) e o link do cliente ficam fora do alcance da tela.
create table mavi_private.sm_tokens (
 company_id uuid not null,
 contract_id uuid not null,
 page_token_cipher text not null check (page_token_cipher like 'v1:%'),
 updated_at timestamptz not null default now(),
 primary key (company_id, contract_id),
 foreign key (company_id, contract_id) references public.contracts(company_id, id) on delete cascade
);
create table mavi_private.sm_links (
 company_id uuid not null,
 contract_id uuid not null,
 token text not null unique check (token ~ '^[0-9a-f]{64}$'),
 created_by uuid,
 created_at timestamptz not null default now(),
 primary key (company_id, contract_id),
 foreign key (company_id, contract_id) references public.contracts(company_id, id) on delete cascade
);
create table mavi_private.sm_oauth_states (
 state text primary key check (state ~ '^[0-9a-f]{64}$'),
 company_id uuid not null,
 contract_id uuid not null,
 -- A agência: quem conectou; o link do cliente: null.
 user_id uuid,
 via text not null check (via in ('agency', 'client')),
 created_at timestamptz not null default now()
);
-- As Páginas que o login trouxe, até alguém escolher uma (30 minutos).
create table mavi_private.sm_pending (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 contract_id uuid not null,
 user_id uuid,
 via text not null check (via in ('agency', 'client')),
 fb_user_name text not null default '',
 -- [{id, name, ig_id, ig_username, token_cipher}]
 pages jsonb not null check (jsonb_typeof(pages) = 'array'),
 created_at timestamptz not null default now()
);
alter table mavi_private.sm_tokens enable row level security;
alter table mavi_private.sm_links enable row level security;
alter table mavi_private.sm_oauth_states enable row level security;
alter table mavi_private.sm_pending enable row level security;
revoke all on mavi_private.sm_tokens, mavi_private.sm_links, mavi_private.sm_oauth_states, mavi_private.sm_pending
 from public, anon, authenticated;

-- ------------------------------------------------------------ fila de publicação
alter table public.social_media_schedules drop constraint social_media_schedules_status_check;
alter table public.social_media_schedules add constraint social_media_schedules_status_check
 check (status in ('scheduled', 'publishing', 'due', 'published', 'failed'));
alter table public.social_media_schedules
 -- O andamento da publicação: contêineres, ids e links por destino.
 add column meta_state jsonb not null default '{}' check (jsonb_typeof(meta_state) = 'object'),
 add column claimed_at timestamptz,
 add column publish_started_at timestamptz;
create index social_media_schedules_publishing on public.social_media_schedules(claimed_at)
 where status = 'publishing';

-- ------------------------------------------------------------ ajudantes
-- O contrato do Social Media que quem chama pode gravar (company, contrato).
create function mavi_private.social_media_contract(p_contract uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare c uuid; begin
 select company_id into c from public.contracts where id = p_contract;
 if c is null or not mavi_private.social_leads_can_write(c, p_contract) then
  raise exception 'Cliente não encontrado.' using errcode = 'P0002';
 end if;
 if mavi_private.social_leads_module_of(c, p_contract) <> 'social_media' then
  raise exception 'A conexão é do Social Media.' using errcode = '22023';
 end if;
 return c;
end $$;
revoke all on function mavi_private.social_media_contract(uuid) from public, anon, authenticated;

create function mavi_private.social_media_client_name(c uuid, k uuid) returns text
language sql stable security definer set search_path = '' as $$
 select coalesce(nullif(b.fields->>'clientName', ''), cl.name)
 from public.contracts x join public.clients cl on cl.company_id = x.company_id and cl.id = x.client_id
 left join public.social_leads_briefings b on b.company_id = x.company_id and b.contract_id = x.id
 where x.company_id = c and x.id = k
$$;
revoke all on function mavi_private.social_media_client_name(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ conectar pela agência
create function public.social_media_begin_connect(p_contract uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.social_media_contract(p_contract);
 s text := encode(extensions.gen_random_bytes(32), 'hex'); begin
 if not mavi_private.leader(c) then
  raise exception 'Pela agência, só administradores e gestores conectam. Mande o link para o cliente conectar.'
   using errcode = '42501';
 end if;
 delete from mavi_private.sm_oauth_states where created_at < now() - interval '15 minutes'
  or (user_id = auth.uid() and contract_id = p_contract);
 insert into mavi_private.sm_oauth_states(state, company_id, contract_id, user_id, via)
 values (s, c, p_contract, auth.uid(), 'agency');
 return s;
end $$;
revoke all on function public.social_media_begin_connect(uuid) from public, anon;
grant execute on function public.social_media_begin_connect(uuid) to authenticated;

-- ------------------------------------------------------------ link do cliente
-- O link (cria na primeira vez; p_new troca, e o anterior para de funcionar).
create function public.social_media_connect_link(p_contract uuid, p_new boolean default false) returns text
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.social_media_contract(p_contract); t text; begin
 select token into t from mavi_private.sm_links where company_id = c and contract_id = p_contract;
 if t is null or p_new then
  t := encode(extensions.gen_random_bytes(32), 'hex');
  insert into mavi_private.sm_links(company_id, contract_id, token, created_by) values (c, p_contract, t, auth.uid())
  on conflict (company_id, contract_id) do update set token = excluded.token, created_by = excluded.created_by,
   created_at = now();
 end if;
 return t;
end $$;
revoke all on function public.social_media_connect_link(uuid, boolean) from public, anon;
grant execute on function public.social_media_connect_link(uuid, boolean) to authenticated;

-- O que a página do link mostra (sem login).
create function public.social_media_link_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare l mavi_private.sm_links; a public.social_media_accounts; co public.companies; begin
 select * into l from mavi_private.sm_links where token = p_token;
 if not found then raise exception 'Link inválido ou trocado.' using errcode = 'P0002'; end if;
 select * into a from public.social_media_accounts where company_id = l.company_id and contract_id = l.contract_id;
 select * into co from public.companies where id = l.company_id;
 return jsonb_build_object('company', co.name, 'company_logo', co.logo_url,
  'client', mavi_private.social_media_client_name(l.company_id, l.contract_id),
  'connected', a.page_id is not null, 'page_name', a.page_name, 'ig_username', a.ig_username,
  'connected_at', a.connected_at, 'error', a.connection_error);
end $$;
revoke all on function public.social_media_link_info(text) from public;
grant execute on function public.social_media_link_info(text) to anon, authenticated;

create function public.social_media_begin_link_connect(p_token text) returns text
language plpgsql security definer set search_path = '' as $$
declare l mavi_private.sm_links; s text := encode(extensions.gen_random_bytes(32), 'hex'); begin
 select * into l from mavi_private.sm_links where token = p_token;
 if not found then raise exception 'Link inválido ou trocado.' using errcode = 'P0002'; end if;
 delete from mavi_private.sm_oauth_states where created_at < now() - interval '15 minutes';
 -- Um link abre no máximo 20 logins pendentes (contra abuso).
 if (select count(*) from mavi_private.sm_oauth_states where contract_id = l.contract_id and via = 'client') >= 20 then
  raise exception 'Muitas tentativas. Espere alguns minutos.' using errcode = '54000';
 end if;
 insert into mavi_private.sm_oauth_states(state, company_id, contract_id, user_id, via)
 values (s, l.company_id, l.contract_id, null, 'client');
 return s;
end $$;
revoke all on function public.social_media_begin_link_connect(text) from public;
grant execute on function public.social_media_begin_link_connect(text) to anon, authenticated;

-- ------------------------------------------------------------ depois do login
-- O servidor guarda as Páginas que o login alcança (tokens já lacrados) e
-- devolve para onde mandar a pessoa escolher.
create function public.social_media_store_pending(p_state text, p_fb_user_name text, p_pages jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s mavi_private.sm_oauth_states; id uuid; x jsonb; clean jsonb := '[]'; begin
 delete from mavi_private.sm_oauth_states where state = p_state and created_at > now() - interval '15 minutes'
 returning * into s;
 if not found then raise exception 'A conexão expirou. Tente de novo.' using errcode = 'P0002'; end if;
 if jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) > 500 then
  raise exception 'Páginas inválidas.' using errcode = '22023';
 end if;
 for x in select value from jsonb_array_elements(p_pages) loop
  if coalesce(x->>'id', '') !~ '^[0-9]{1,30}$' or coalesce(x->>'token_cipher', '') not like 'v1:%'
   or (x->>'ig_id' is not null and x->>'ig_id' !~ '^[0-9]{1,30}$') then
   raise exception 'Página inválida.' using errcode = '22023';
  end if;
  clean := clean || jsonb_build_object('id', x->>'id', 'name', left(coalesce(x->>'name', ''), 200),
   'ig_id', x->>'ig_id', 'ig_username', left(x->>'ig_username', 100), 'token_cipher', x->>'token_cipher');
 end loop;
 delete from mavi_private.sm_pending where created_at < now() - interval '30 minutes'
  or (contract_id = s.contract_id and user_id is not distinct from s.user_id and via = s.via);
 insert into mavi_private.sm_pending(company_id, contract_id, user_id, via, fb_user_name, pages)
 values (s.company_id, s.contract_id, s.user_id, s.via, left(coalesce(p_fb_user_name, ''), 200), clean)
 returning sm_pending.id into id;
 return jsonb_build_object('pending', id, 'via', s.via, 'contract', s.contract_id,
  'month', (select max(month_number) from public.social_leads_plans where company_id = s.company_id
   and contract_id = s.contract_id),
  'link', (select token from mavi_private.sm_links where company_id = s.company_id and contract_id = s.contract_id),
  'pages', jsonb_array_length(clean));
end $$;
revoke all on function public.social_media_store_pending(text, text, jsonb) from public;
grant execute on function public.social_media_store_pending(text, text, jsonb) to anon, authenticated;

create function mavi_private.social_media_pages_of(p mavi_private.sm_pending) returns jsonb
language sql immutable set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', x->>'id', 'name', x->>'name', 'ig_id', x->>'ig_id',
  'ig_username', x->>'ig_username') order by x->>'name'), '[]')
 from jsonb_array_elements(p.pages) x
$$;
revoke all on function mavi_private.social_media_pages_of(mavi_private.sm_pending) from public, anon, authenticated;

-- As Páginas para quem conectou pela agência escolher.
create function public.social_media_pending_pages(p_pending uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p mavi_private.sm_pending; begin
 select * into p from mavi_private.sm_pending where id = p_pending and via = 'agency' and user_id = auth.uid()
  and created_at > now() - interval '30 minutes';
 if not found then raise exception 'A escolha expirou. Conecte de novo.' using errcode = 'P0002'; end if;
 return jsonb_build_object('contract', p.contract_id, 'fb_user_name', p.fb_user_name,
  'client', mavi_private.social_media_client_name(p.company_id, p.contract_id),
  'pages', mavi_private.social_media_pages_of(p));
end $$;
revoke all on function public.social_media_pending_pages(uuid) from public, anon;
grant execute on function public.social_media_pending_pages(uuid) to authenticated;

-- As Páginas para o cliente escolher (pelo link).
create function public.social_media_link_pending(p_token text, p_pending uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare l mavi_private.sm_links; p mavi_private.sm_pending; begin
 select * into l from mavi_private.sm_links where token = p_token;
 select * into p from mavi_private.sm_pending where id = p_pending and via = 'client'
  and contract_id = l.contract_id and created_at > now() - interval '30 minutes';
 if l.token is null or p.id is null then
  raise exception 'A escolha expirou. Entre com o Facebook de novo.' using errcode = 'P0002';
 end if;
 return jsonb_build_object('fb_user_name', p.fb_user_name, 'pages', mavi_private.social_media_pages_of(p));
end $$;
revoke all on function public.social_media_link_pending(text, uuid) from public;
grant execute on function public.social_media_link_pending(text, uuid) to anon, authenticated;

create function mavi_private.social_media_apply_page(p mavi_private.sm_pending, p_page text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x jsonb; begin
 select value into x from jsonb_array_elements(p.pages) where value->>'id' = p_page;
 if x is null then raise exception 'Escolha uma das Páginas da lista.' using errcode = '22023'; end if;
 insert into mavi_private.sm_tokens(company_id, contract_id, page_token_cipher)
 values (p.company_id, p.contract_id, x->>'token_cipher')
 on conflict (company_id, contract_id) do update set page_token_cipher = excluded.page_token_cipher, updated_at = now();
 insert into public.social_media_accounts(company_id, contract_id, page_id, page_name, ig_user_id, ig_username,
  connected_via, connected_name, connected_by, connected_at, connection_error, connection_error_at, updated_by)
 values (p.company_id, p.contract_id, x->>'id', x->>'name', x->>'ig_id', x->>'ig_username', p.via,
  nullif(p.fb_user_name, ''), p.user_id, now(), null, null, p.user_id)
 on conflict (company_id, contract_id) do update set page_id = excluded.page_id, page_name = excluded.page_name,
  ig_user_id = excluded.ig_user_id, ig_username = excluded.ig_username, connected_via = excluded.connected_via,
  connected_name = excluded.connected_name, connected_by = excluded.connected_by, connected_at = now(),
  connection_error = null, connection_error_at = null, updated_by = excluded.updated_by, updated_at = now();
 delete from mavi_private.sm_pending where id = p.id;
 return jsonb_build_object('page_name', x->>'name', 'ig_username', x->>'ig_username');
end $$;
revoke all on function mavi_private.social_media_apply_page(mavi_private.sm_pending, text) from public, anon, authenticated;

create function public.social_media_choose_page(p_pending uuid, p_page text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p mavi_private.sm_pending; begin
 select * into p from mavi_private.sm_pending where id = p_pending and via = 'agency' and user_id = auth.uid()
  and created_at > now() - interval '30 minutes';
 if not found then raise exception 'A escolha expirou. Conecte de novo.' using errcode = 'P0002'; end if;
 perform mavi_private.social_media_contract(p.contract_id);
 if not mavi_private.leader(p.company_id) then
  raise exception 'Pela agência, só administradores e gestores conectam.' using errcode = '42501';
 end if;
 return mavi_private.social_media_apply_page(p, p_page);
end $$;
revoke all on function public.social_media_choose_page(uuid, text) from public, anon;
grant execute on function public.social_media_choose_page(uuid, text) to authenticated;

create function public.social_media_link_choose(p_token text, p_pending uuid, p_page text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l mavi_private.sm_links; p mavi_private.sm_pending; begin
 select * into l from mavi_private.sm_links where token = p_token;
 select * into p from mavi_private.sm_pending where id = p_pending and via = 'client'
  and contract_id = l.contract_id and created_at > now() - interval '30 minutes';
 if l.token is null or p.id is null then
  raise exception 'A escolha expirou. Entre com o Facebook de novo.' using errcode = 'P0002';
 end if;
 return mavi_private.social_media_apply_page(p, p_page);
end $$;
revoke all on function public.social_media_link_choose(text, uuid, text) from public;
grant execute on function public.social_media_link_choose(text, uuid, text) to anon, authenticated;

create function public.social_media_disconnect(p_contract uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c uuid := mavi_private.social_media_contract(p_contract); begin
 if exists (select 1 from public.social_media_schedules where company_id = c and contract_id = p_contract
  and status = 'publishing') then
  raise exception 'Há um post sendo publicado agora. Espere terminar.' using errcode = '22023';
 end if;
 delete from mavi_private.sm_tokens where company_id = c and contract_id = p_contract;
 update public.social_media_accounts set page_id = null, page_name = null, ig_user_id = null, ig_username = null,
  connected_via = null, connected_name = null, connected_by = null, connected_at = null, connection_error = null,
  connection_error_at = null, updated_by = auth.uid(), updated_at = now()
 where company_id = c and contract_id = p_contract;
end $$;
revoke all on function public.social_media_disconnect(uuid) from public, anon;
grant execute on function public.social_media_disconnect(uuid) to authenticated;

-- ------------------------------------------------------------ fase 1, com a publicação
-- Agendar e cancelar: não durante a publicação (a da migração 20270315090000).
create or replace function public.social_media_schedule_cancel(p_plan uuid, p_number integer) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; s public.social_media_schedules; begin
 p := mavi_private.social_media_plan(p_plan);
 if exists (select 1 from public.social_media_schedules where plan_id = p.id and number = p_number
  and status = 'publishing') then
  raise exception 'O post está sendo publicado pelo Meta agora.' using errcode = '22023';
 end if;
 delete from public.social_media_schedules where plan_id = p.id and number = p_number and status <> 'published'
 returning * into s;
 if not found then
  raise exception 'Agendamento não encontrado (ou o post já foi publicado).' using errcode = 'P0002';
 end if;
 perform mavi_private.social_media_event(s, 'unscheduled', '', jsonb_build_object('at', s.scheduled_at));
end $$;

create function mavi_private.social_media_not_publishing() returns trigger
language plpgsql set search_path = '' as $$ begin
 -- Só o worker (sem login) mexe num post que está sendo publicado.
 if old.status = 'publishing' and auth.uid() is not null then
  raise exception 'O post % está sendo publicado pelo Meta agora. Espere terminar.', old.number using errcode = '22023';
 end if;
 return new;
end $$;
revoke all on function mavi_private.social_media_not_publishing() from public, anon, authenticated;
create trigger social_media_not_publishing before update on public.social_media_schedules
 for each row execute function mavi_private.social_media_not_publishing();

-- ------------------------------------------------------------ na hora marcada
-- Com o cliente conectado (sem erro na conexão), vai para a fila do Meta;
-- sem conexão, o lembrete de sempre. Depois acorda o worker se há fila.
create or replace function mavi_private.social_media_run_schedules() returns integer
language plpgsql security definer set search_path = '' as $$
declare s public.social_media_schedules; x public.social_leads_posts; p public.social_leads_plans; client text;
 err text; who uuid; link text; n integer := 0; auto boolean; begin
 for s in select * from public.social_media_schedules where status = 'scheduled' and scheduled_at <= now()
  order by scheduled_at limit 200 for update skip locked loop
  select * into x from public.social_leads_posts where plan_id = s.plan_id and number = s.number;
  select * into p from public.social_leads_plans where id = s.plan_id;
  err := case when x.decision <> 'approved' then 'O post não está mais aprovado.'
   when jsonb_array_length(coalesce(x.arts, '[]')) = 0 then 'O post ficou sem arte.' end;
  auto := err is null and exists (select 1 from public.social_media_accounts a
   join mavi_private.sm_tokens t on t.company_id = a.company_id and t.contract_id = a.contract_id
   where a.company_id = s.company_id and a.contract_id = s.contract_id and a.page_id is not null
    and a.connection_error is null
    and ('instagram' <> all(s.destinations) and 'story' <> all(s.destinations) or a.ig_user_id is not null));
  if auto then
   update public.social_media_schedules set status = 'publishing', claimed_at = null, publish_started_at = now(),
    meta_state = '{}', error = null, updated_at = now()
   where plan_id = s.plan_id and number = s.number;
   n := n + 1;
   continue;
  end if;
  update public.social_media_schedules set status = case when err is null then 'due' else 'failed' end,
   reminded_at = now(), error = err, updated_at = now()
  where plan_id = s.plan_id and number = s.number;
  client := mavi_private.social_media_client_name(s.company_id, s.contract_id);
  link := mavi_private.social_leads_module_path('social_media') || '?contrato=' || s.contract_id
   || '&mes=' || p.month_number || '&secao=agendamento&post=' || s.number;
  for who in select mavi_private.social_media_schedule_people(s) loop
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   values (s.company_id, who, null, null, 'social_leads',
    case when err is null then format('Hora de publicar o post %s de %s', s.number, client)
     else format('O post %s de %s não pode ser publicado', s.number, client) end,
    case when err is null then format('%s · arte e legenda prontas no Agendamento. Publique e marque como publicado.', p.label)
     else err || ' Ajuste e agende de novo.' end,
    link);
  end loop;
  n := n + 1;
 end loop;
 perform mavi_private.social_media_kick();
 return n;
end $$;

-- Acorda o worker quando há post na fila (ou esperando o Meta processar um
-- vídeo); uma chamada por minuto basta: o worker leva a fila inteira.
create function mavi_private.social_media_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 if not exists (select 1 from public.social_media_schedules where status = 'publishing'
  and (claimed_at is null or claimed_at < now() - interval '5 minutes')) then return; end if;
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 perform net.http_post(url := regexp_replace(cfg.url, '/api/[a-z-]+/?$', '/api/social-media'),
  body := '{"action":"publish"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.social_media_kick() from public, anon, authenticated;

-- ------------------------------------------------------------ o worker
-- Os posts da fila, reservados por 5 minutos, com tudo para publicar.
create function public.social_media_claim_publish(p_secret text, p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare jobs jsonb := '[]'; s public.social_media_schedules; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for s in select * from public.social_media_schedules where status = 'publishing'
  and (claimed_at is null or claimed_at < now() - interval '5 minutes')
  order by scheduled_at limit least(greatest(coalesce(p_limit, 10), 1), 20) for update skip locked loop
  update public.social_media_schedules set claimed_at = now() where plan_id = s.plan_id and number = s.number;
  jobs := jobs || (select jsonb_build_object('plan', s.plan_id, 'number', s.number, 'company', s.company_id,
   'contract', s.contract_id, 'destinations', to_jsonb(s.destinations), 'caption', coalesce(s.caption, x.caption, ''),
   'first_comment', s.first_comment, 'cover', s.cover, 'state', s.meta_state,
   'started_at', s.publish_started_at, 'page_id', a.page_id, 'ig_user_id', a.ig_user_id,
   'token_cipher', t.page_token_cipher,
   'arts', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'type', f.content_type,
     'path', f.path) order by e.ord)
    from jsonb_array_elements(x.arts) with ordinality e(v, ord)
    join public.drive_files f on f.company_id = s.company_id and f.id = (e.v->>'id')::uuid and f.status = 'ready'),
    '[]'))
   from public.social_leads_posts x
   left join public.social_media_accounts a on a.company_id = s.company_id and a.contract_id = s.contract_id
   left join mavi_private.sm_tokens t on t.company_id = s.company_id and t.contract_id = s.contract_id
   where x.plan_id = s.plan_id and x.number = s.number);
 end loop;
 return jobs;
end $$;
revoke all on function public.social_media_claim_publish(text, integer) from public;
grant execute on function public.social_media_claim_publish(text, integer) to anon, authenticated;

-- O andamento (vídeo ainda processando): guarda e solta a reserva para a
-- rodada do próximo minuto (não para esta: o worker não fica girando).
create function public.social_media_publish_progress(p_secret text, p_plan uuid, p_number integer, p_state jsonb)
 returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.social_media_schedules set meta_state = coalesce(p_state, '{}'),
  claimed_at = now() - interval '4 minutes', updated_at = now()
 where plan_id = p_plan and number = p_number and status = 'publishing';
end $$;
revoke all on function public.social_media_publish_progress(text, uuid, integer, jsonb) from public;
grant execute on function public.social_media_publish_progress(text, uuid, integer, jsonb) to anon, authenticated;

-- O fim: tudo publicado, ou volta para o lembrete com o motivo.
-- p_comment_error: o post saiu, só o primeiro comentário não (aviso à parte).
create function public.social_media_publish_done(p_secret text, p_plan uuid, p_number integer, p_state jsonb,
 p_ok boolean, p_url text, p_error text, p_token_error boolean default false, p_comment_error text default null)
 returns void
language plpgsql security definer set search_path = '' as $$
declare s public.social_media_schedules; p public.social_leads_plans; client text; who uuid; link text; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into s from public.social_media_schedules where plan_id = p_plan and number = p_number and status = 'publishing'
 for update;
 if not found then return; end if;
 select * into p from public.social_leads_plans where id = s.plan_id;
 client := mavi_private.social_media_client_name(s.company_id, s.contract_id);
 link := mavi_private.social_leads_module_path('social_media') || '?contrato=' || s.contract_id
  || '&mes=' || p.month_number || '&secao=agendamento&post=' || s.number;
 if p_ok then
  update public.social_media_schedules set status = 'published', published_at = now(), published_via = 'meta',
   published_url = case when p_url ~* '^https://[^\s]+$' then left(p_url, 500) end, published_by = null,
   error = null, meta_state = coalesce(p_state, '{}'), claimed_at = null, updated_at = now()
  where plan_id = s.plan_id and number = s.number returning * into s;
  insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id,
   actor_name, note, detail)
  values (s.company_id, s.contract_id, s.plan_id, s.number, 'published', 'team', null, 'Meta', '',
   jsonb_build_object('url', s.published_url, 'via', 'meta'));
  if p_comment_error is not null then
   for who in select mavi_private.social_media_schedule_people(s) loop
    insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
    values (s.company_id, who, null, null, 'social_leads',
     format('Post %s de %s publicado, sem o primeiro comentário', s.number, client),
     left(p_comment_error, 300) || ' Comente à mão no post publicado.', link);
   end loop;
  end if;
  return;
 end if;
 update public.social_media_schedules set status = 'due', reminded_at = now(),
  error = left(coalesce(nullif(p_error, ''), 'O Meta não publicou.'), 1000),
  published_url = case when p_url ~* '^https://[^\s]+$' then left(p_url, 500) end,
  meta_state = coalesce(p_state, '{}'), claimed_at = null, updated_at = now()
 where plan_id = s.plan_id and number = s.number returning * into s;
 if p_token_error then
  update public.social_media_accounts set connection_error = left(coalesce(p_error, 'A conexão com o Meta caiu.'), 500),
   connection_error_at = now(), updated_at = now()
  where company_id = s.company_id and contract_id = s.contract_id;
 end if;
 for who in select mavi_private.social_media_schedule_people(s) loop
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
  values (s.company_id, who, null, null, 'social_leads',
   format('Não deu para publicar o post %s de %s pelo Meta', s.number, client),
   left(s.error, 250) || case when p_token_error then ' Reconecte o Meta do cliente no Agendamento.' else '' end
    || ' Publique à mão e marque como publicado.',
   link);
 end loop;
end $$;
revoke all on function public.social_media_publish_done(text, uuid, integer, jsonb, boolean, text, text, boolean, text)
 from public;
grant execute on function public.social_media_publish_done(text, uuid, integer, jsonb, boolean, text, text, boolean, text)
 to anon, authenticated;

-- A carteira conta 'publishing' como agendado (não como pendente): a da
-- migração 20270315090000 já faz isso ('due' só conta due e failed).

-- O link de quem conectou fica guardado só com o contrato: limpeza do que expirou.
do $$ begin
 if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
  perform cron.schedule('mavi-social-media-oauth-cleanup', '17 * * * *',
   $c$delete from mavi_private.sm_oauth_states where created_at < now() - interval '1 hour';
   delete from mavi_private.sm_pending where created_at < now() - interval '1 hour'$c$);
 end if;
end $$;

notify pgrst, 'reload schema';

commit;
