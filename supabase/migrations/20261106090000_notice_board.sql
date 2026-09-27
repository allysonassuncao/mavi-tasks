begin;

-- Mural de avisos. Administradores e gestores avisam pessoas, equipes,
-- clientes e projetos (quem atende o cliente/projeto: as equipes dele, os
-- responsáveis pelas tarefas abertas, ou os dois), com exclusões. Cada aviso
-- sai em um ou mais formatos — popup, caixa de entrada, push e faixa no topo —
-- e sempre fica na página do Mural de quem o recebeu.
--
-- - Quem pode: administradores avisam qualquer um (inclusive "todos");
--   gestores só dentro do próprio escopo: as equipes em que estão, os
--   clientes dessas equipes, os projetos desses clientes e as pessoas dessas
--   equipes. Colaboradores não criam avisos.
-- - Público dinâmico: o público é recalculado enquanto o aviso está no ar.
--   Quem entra numa equipe (ou vira responsável por uma tarefa do cliente)
--   depois da publicação recebe o aviso na rodada seguinte da rotina
--   (a cada minuto).
-- - Entrega: cada pessoa alcançada ganha uma linha em notice_receipts (a
--   rodada que recebeu e o que fez: viu, confirmou "Li e entendi", adiou o
--   popup para amanhã, fechou a faixa). A leitura do app (popup, faixa,
--   Mural) é só um índice por pessoa, sem recalcular públicos.
-- - Tempo real: um aviso pequeno no canal da empresa (kind 'notice', com as
--   pessoas alcançadas quando são poucas) faz cada app recarregar os seus
--   avisos; as linhas da caixa de entrada deste módulo não disparam um
--   broadcast nem um push por pessoa: o push sai em lotes de 50 navegadores.
-- - Agenda: publicar em / sair do ar em, repetição (todo dia, dias úteis,
--   semanal, quinzenal, mensal) no horário da publicação. Cada repetição ou
--   "avisar de novo" é uma rodada nova: o aviso volta como não visto.

-- ------------------------------------------------------------ tabelas
create table public.notices (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 created_by uuid not null,
 title text not null check (length(btrim(title)) between 2 and 160),
 body text not null default '' check (length(body) <= 60000),
 level text not null default 'info' check (level in ('info', 'important', 'critical')),
 popup boolean not null default false,
 inbox boolean not null default true,
 push boolean not null default false,
 banner boolean not null default false,
 pinned boolean not null default false,
 require_ack boolean not null default false,
 -- Nulo: rascunho.
 publish_at timestamptz,
 expires_at timestamptz,
 repeat text check (repeat in ('daily', 'weekdays', 'weekly', 'biweekly', 'monthly')),
 next_repeat timestamptz,
 -- Cada entrega (publicação, repetição, "avisar de novo") é uma rodada.
 round integer not null default 1 check (round >= 1),
 archived_at timestamptz,
 archived_by uuid,
 search text not null default '',
 version integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid,
 unique (company_id, id),
 foreign key (company_id, created_by) references public.memberships(company_id, user_id),
 check (expires_at is null or publish_at is null or expires_at > publish_at),
 check (repeat is null or publish_at is not null)
);
create index notices_company on public.notices(company_id, created_at desc);
create index notices_live on public.notices(publish_at) where archived_at is null and publish_at is not null;
create index notices_repeat on public.notices(next_repeat) where repeat is not null and archived_at is null;
alter table public.notices enable row level security;
revoke all on public.notices from public, anon, authenticated;

-- Quem recebe: kind 'everyone' | 'user' | 'team' | 'client' | 'project', e
-- 'exclude' para as pessoas tiradas do público. Cliente e projeto dizem quem
-- os atende (mode): as equipes, os responsáveis pelas tarefas abertas, ou os dois.
create table public.notice_targets (
 company_id uuid not null,
 notice_id uuid not null,
 kind text not null check (kind in ('everyone', 'user', 'team', 'client', 'project', 'exclude')),
 target_id uuid,
 mode text check (mode in ('teams', 'assignees', 'both')),
 foreign key (company_id, notice_id) references public.notices(company_id, id) on delete cascade,
 check ((kind = 'everyone') = (target_id is null)),
 check ((kind in ('client', 'project')) = (mode is not null)),
 unique nulls not distinct (notice_id, kind, target_id)
);
alter table public.notice_targets enable row level security;
revoke all on public.notice_targets from public, anon, authenticated;

create table public.notice_receipts (
 company_id uuid not null,
 notice_id uuid not null,
 user_id uuid not null,
 round integer not null,
 delivered_at timestamptz not null default now(),
 seen_at timestamptz,
 acked_at timestamptz,
 snoozed_until timestamptz,
 banner_closed_at timestamptz,
 primary key (notice_id, user_id),
 foreign key (company_id, notice_id) references public.notices(company_id, id) on delete cascade,
 foreign key (company_id, user_id) references public.memberships(company_id, user_id)
);
create index notice_receipts_person on public.notice_receipts(company_id, user_id, delivered_at desc);
alter table public.notice_receipts enable row level security;
revoke all on public.notice_receipts from public, anon, authenticated;

-- Anexos: enviados agora (bucket do Drive, pasta notices/) ou um arquivo que
-- já está no Drive (o aviso dá a quem o recebeu o direito de abri-lo).
create table public.notice_attachments (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 notice_id uuid not null,
 source text not null check (source in ('upload', 'drive')),
 drive_file_id uuid,
 name text not null check (length(btrim(name)) between 1 and 255),
 content_type text not null check (length(content_type) between 3 and 200),
 size_bytes bigint not null check (size_bytes between 1 and 524288000),
 path text unique,
 status text not null default 'uploading' check (status in ('uploading', 'ready')),
 position integer not null default 0,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 unique (company_id, id),
 unique (notice_id, drive_file_id),
 foreign key (company_id, notice_id) references public.notices(company_id, id) on delete cascade,
 foreign key (company_id, drive_file_id) references public.drive_files(company_id, id) on delete cascade,
 check ((source = 'drive') = (drive_file_id is not null) and (source = 'upload') = (path is not null))
);
create index notice_attachments_notice on public.notice_attachments(company_id, notice_id, position);
alter table public.notice_attachments enable row level security;
revoke all on public.notice_attachments from public, anon, authenticated;

-- A caixa de entrada ganha os avisos do Mural.
alter table public.notifications add column notice_id uuid;
alter table public.notifications add constraint notifications_notice_fk
 foreign key (company_id, notice_id) references public.notices(company_id, id) on delete cascade;
create index notifications_notice on public.notifications(notice_id, user_id) where notice_id is not null;
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));

-- Os avisos do Mural chegam aos apps pelo canal da empresa e o push sai em
-- lotes (mavi_private.notice_deliver): sem um broadcast e um push por linha.
drop trigger broadcast_notification on public.notifications;
create trigger broadcast_notification after insert on public.notifications
 for each row when (new.kind <> 'notice') execute function mavi_private.broadcast_notification();
drop trigger push_notification on public.notifications;
create trigger push_notification after insert on public.notifications
 for each row when (new.kind <> 'notice') execute function mavi_private.push_notification();

-- ------------------------------------------------------------ regras
create function mavi_private.notice_status(n public.notices) returns text
language sql stable set search_path = '' as $$
 select case
  when n.publish_at is null then 'draft'
  when n.archived_at is not null or (n.expires_at is not null and n.expires_at <= now()) then 'ended'
  when n.publish_at > now() then 'scheduled'
  else 'live' end
$$;

-- Edita (e encerra, apaga, anexa): administradores, ou o gestor que criou.
create function mavi_private.notice_can_edit(n public.notices) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.admin(n.company_id) or (n.created_by = auth.uid() and mavi_private.leader(n.company_id))
$$;

-- Vê: quem edita e quem o recebeu.
create function mavi_private.notice_can_see(n public.notices) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(n.company_id) and (mavi_private.notice_can_edit(n) or exists (
  select 1 from public.notice_receipts r where r.notice_id = n.id and r.user_id = auth.uid()))
$$;

-- Se quem está salvando pode avisar esse alvo. Gestores: só o próprio escopo.
create function mavi_private.notice_target_ok(c uuid, p_kind text, p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select case
  when p_kind = 'exclude' then exists (
   select 1 from public.memberships where company_id = c and user_id = p_id)
  when mavi_private.admin(c) then case p_kind
   when 'everyone' then true
   when 'user' then exists (select 1 from public.memberships where company_id = c and user_id = p_id and active)
   when 'team' then exists (select 1 from public.teams where company_id = c and id = p_id)
   when 'client' then exists (select 1 from public.clients where company_id = c and id = p_id and not archived)
   when 'project' then exists (select 1 from public.projects where company_id = c and id = p_id and not archived)
   else false end
  when mavi_private.leader(c) then case p_kind
   when 'user' then exists (
    select 1 from public.team_members a
    join public.team_members b on b.company_id = a.company_id and b.team_id = a.team_id
    join public.memberships m on m.company_id = b.company_id and m.user_id = b.user_id and m.active
    where a.company_id = c and a.user_id = auth.uid() and b.user_id = p_id)
   when 'team' then exists (
    select 1 from public.team_members where company_id = c and team_id = p_id and user_id = auth.uid())
   when 'client' then exists (
    select 1 from public.client_teams ct
    join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
    join public.clients cl on cl.company_id = ct.company_id and cl.id = ct.client_id and not cl.archived
    where ct.company_id = c and ct.client_id = p_id and tm.user_id = auth.uid())
   when 'project' then exists (
    select 1 from public.projects p
    join public.contracts k on k.company_id = p.company_id and k.id = p.contract_id
    join public.client_teams ct on ct.company_id = k.company_id and ct.client_id = k.client_id
    join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
    where p.company_id = c and p.id = p_id and not p.archived and tm.user_id = auth.uid())
   else false end
  else false end
$$;

-- As pessoas que o aviso alcança agora (ativas, sem as excluídas e sem quem o criou).
create function mavi_private.notice_audience(p_notice uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
 with n as (select id, company_id, created_by from public.notices where id = p_notice),
 t as (select x.* from public.notice_targets x join n on x.notice_id = n.id),
 picked as (
  select m.user_id from n join public.memberships m on m.company_id = n.company_id
   where exists (select 1 from t where t.kind = 'everyone')
  union
  select t.target_id from t where t.kind = 'user'
  union
  select tm.user_id from t
   join public.team_members tm on tm.company_id = t.company_id and tm.team_id = t.target_id
   where t.kind = 'team'
  union
  select tm.user_id from t
   join public.client_teams ct on ct.company_id = t.company_id and ct.client_id = t.target_id
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
   where t.kind = 'client' and t.mode in ('teams', 'both')
  union
  select tk.assignee_id from t
   join public.contracts k on k.company_id = t.company_id and k.client_id = t.target_id
   join public.tasks tk on tk.company_id = k.company_id and tk.contract_id = k.id
   where t.kind = 'client' and t.mode in ('assignees', 'both') and not tk.archived and tk.status <> 'done'
  union
  select tm.user_id from t
   join public.projects p on p.company_id = t.company_id and p.id = t.target_id
   join public.contracts k on k.company_id = p.company_id and k.id = p.contract_id
   join public.client_teams ct on ct.company_id = k.company_id and ct.client_id = k.client_id
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
   where t.kind = 'project' and t.mode in ('teams', 'both')
  union
  select tk.assignee_id from t
   join public.projects p on p.company_id = t.company_id and p.id = t.target_id
   join public.tasks tk on tk.company_id = p.company_id and tk.contract_id = p.contract_id and tk.project_id = p.id
   where t.kind = 'project' and t.mode in ('assignees', 'both') and not tk.archived and tk.status <> 'done'
 )
 select p.user_id from picked p
 join n on true
 join public.memberships m on m.company_id = n.company_id and m.user_id = p.user_id and m.active
 where p.user_id <> n.created_by
  and not exists (select 1 from t where t.kind = 'exclude' and t.target_id = p.user_id)
$$;

create function mavi_private.notice_excerpt(n public.notices) returns text
language sql immutable set search_path = '' as $$
 select left(btrim(regexp_replace(mavi_private.rich_plain(n.body), '\s+', ' ', 'g')), 200)
$$;

-- O texto da busca (sem acentos).
create function mavi_private.notice_search_text() returns trigger
language plpgsql set search_path = '' as $$ begin
 new.search := mavi_private.fold(concat_ws(' ', new.title, mavi_private.rich_plain(new.body)));
 return new;
end $$;
create trigger notice_search before insert or update of title, body on public.notices
 for each row execute function mavi_private.notice_search_text();

-- A próxima repetição depois de agora, no horário da publicação (fuso da empresa).
create function mavi_private.notice_next_repeat(n public.notices) returns timestamptz
language sql stable security definer set search_path = '' as $$
 with z as (select coalesce((select timezone from public.companies where id = n.company_id), 'America/Sao_Paulo') as tz)
 select case when n.repeat is null or n.publish_at is null then null else
  (mavi_private.next_recurrence(n.repeat, (n.publish_at at time zone z.tz)::date,
    greatest((now() at time zone z.tz)::date, (n.publish_at at time zone z.tz)::date))
   + (n.publish_at at time zone z.tz)::time) at time zone z.tz end
 from z
$$;

-- Push em lotes de 50 navegadores (o limite do /api/push).
create function mavi_private.notice_push(n public.notices, p_users uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.push_config; batch jsonb; begin
 select * into cfg from mavi_private.push_config where id;
 if cfg.url is null or coalesce(cardinality(p_users), 0) = 0 then return; end if;
 for batch in
  select jsonb_agg(jsonb_build_object('endpoint', s.endpoint,
   'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth)))
  from (select s.*, (row_number() over (order by s.endpoint) - 1) / 50 as g
   from public.push_subscriptions s where s.user_id = any(p_users)) s
  group by s.g
 loop
  perform net.http_post(
   url := cfg.url,
   body := jsonb_build_object('subscriptions', batch, 'message', jsonb_build_object(
    'title', left(case n.level when 'critical' then 'Urgente: ' when 'important' then 'Importante: ' else '' end
      || n.title, 120),
    'body', coalesce(nullif(mavi_private.notice_excerpt(n), ''), 'Novo aviso no Mural'),
    'tag', 'notice-' || n.id || '-' || n.round,
    'url', '/mural?aviso=' || n.id)),
   headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
   timeout_milliseconds := 8000);
 end loop;
exception when others then
 -- O aviso continua no Mural e na caixa de entrada mesmo sem o push.
 raise warning 'mavi notice push failed: %', sqlerrm;
end $$;

-- Entrega a rodada atual a quem ainda não a recebeu (todo o público numa
-- rodada nova; só quem entrou depois nas outras vezes). Devolve quantos.
create function mavi_private.notice_deliver(p_notice uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n public.notices; v_users uuid[]; begin
 select * into n from public.notices where id = p_notice;
 if not found or mavi_private.notice_status(n) <> 'live' then return 0; end if;
 with a as (
  select x as user_id from mavi_private.notice_audience(n.id) x
  where not exists (select 1 from public.notice_receipts r
   where r.notice_id = n.id and r.user_id = x and r.round >= n.round)),
 up as (
  insert into public.notice_receipts as r (company_id, notice_id, user_id, round, delivered_at)
  select n.company_id, n.id, a.user_id, n.round, now() from a
  on conflict (notice_id, user_id) do update set round = excluded.round, delivered_at = excluded.delivered_at,
   seen_at = null, acked_at = null, snoozed_until = null, banner_closed_at = null
  returning r.user_id)
 select coalesce(array_agg(user_id), '{}') into v_users from up;
 if cardinality(v_users) = 0 then return 0; end if;
 if n.inbox then
  -- Uma linha por aviso e pessoa: a rodada nova volta ao topo como não lida.
  delete from public.notifications where notice_id = n.id and user_id = any(v_users);
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link, notice_id)
  select n.company_id, u, n.created_by, null, 'notice', left(n.title, 300),
   nullif(mavi_private.notice_excerpt(n), ''), '/mural?aviso=' || n.id, n.id
  from unnest(v_users) u;
 end if;
 if n.push then perform mavi_private.notice_push(n, v_users); end if;
 perform mavi_private.broadcast(n.company_id, jsonb_build_object('kind', 'notice', 'notice', n.id,
  'users', case when cardinality(v_users) <= 200 then to_jsonb(v_users) else null end));
 return cardinality(v_users);
end $$;

-- Um aviso que mudou (conteúdo, encerrado, apagado): todos os apps recarregam.
create function mavi_private.notice_changed(c uuid, p_notice uuid) returns void
language sql security definer set search_path = '' as $$
 select mavi_private.broadcast(c, jsonb_build_object('kind', 'notice', 'notice', p_notice, 'users', null))
$$;

-- Rotina (a cada minuto): repetições que venceram, publicações agendadas e
-- quem entrou no público depois. Só avisos publicados nos últimos 90 dias
-- ganham gente nova.
create function mavi_private.run_notices() returns integer
language plpgsql security definer set search_path = '' as $$
declare n public.notices; total integer := 0; begin
 for n in
  select * from public.notices x
  where x.repeat is not null and x.next_repeat <= now() and mavi_private.notice_status(x) = 'live'
  for update skip locked
 loop
  update public.notices set round = round + 1, next_repeat = mavi_private.notice_next_repeat(n)
  where id = n.id;
 end loop;
 for n in
  select * from public.notices x
  where x.archived_at is null and x.publish_at <= now() and x.publish_at > now() - interval '90 days'
   and (x.expires_at is null or x.expires_at > now())
 loop
  begin
   total := total + mavi_private.notice_deliver(n.id);
  exception when others then
   raise warning 'mavi notice % not delivered: %', n.id, sqlerrm;
  end;
 end loop;
 return total;
end $$;

-- ------------------------------------------------------------ salvar
-- Cria ou salva um aviso. p_content: title, body, level, popup, inbox, push,
-- banner, pinned, require_ack, publish_at (vazio: agora), expires_at, repeat,
-- targets [{kind, id, mode}] e exclude [user ids]. p_publish: false guarda
-- como rascunho (só enquanto não foi publicado); true publica ou agenda.
-- p_renotify: num aviso no ar, entrega de novo a todos (volta como não visto).
create function public.save_notice(p_company uuid, p_notice uuid, p_content jsonb, p_publish boolean default true,
 p_renotify boolean default false, p_version integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n public.notices; old_status text; v_title text; v_body text; v_level text; v_publish timestamptz;
 v_expires timestamptz; v_repeat text; x jsonb; v_kind text; v_id uuid; v_mode text; v_targets integer := 0;
 v_audience uuid[]; v_new boolean := p_notice is null; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores criam avisos.' using errcode = '42501';
 end if;
 if jsonb_typeof(p_content) is distinct from 'object' then raise exception 'Aviso inválido' using errcode = '22023'; end if;
 if not v_new then
  select * into n from public.notices where id = p_notice for update;
  if not found or n.company_id <> p_company then raise exception 'Aviso não encontrado.' using errcode = 'P0002'; end if;
  if not mavi_private.notice_can_edit(n) then raise exception 'Sem permissão para editar este aviso.' using errcode = '42501'; end if;
  if p_version is not null and p_version <> n.version then
   raise exception 'Este aviso foi alterado por outra pessoa. Abra de novo para ver a versão atual.' using errcode = '40001';
  end if;
  old_status := mavi_private.notice_status(n);
  if old_status = 'ended' then raise exception 'Este aviso já foi encerrado.' using errcode = '22023'; end if;
 end if;

 v_title := btrim(regexp_replace(coalesce(p_content->>'title', ''), '\s+', ' ', 'g'));
 if length(v_title) < 2 or length(v_title) > 160 then
  raise exception 'Dê um título de 2 a 160 caracteres.' using errcode = '22023';
 end if;
 v_body := coalesce(p_content->>'body', '');
 if length(v_body) > 60000 then raise exception 'O texto do aviso está longo demais.' using errcode = '22023'; end if;
 v_level := coalesce(nullif(p_content->>'level', ''), 'info');
 if v_level not in ('info', 'important', 'critical') then raise exception 'Nível inválido' using errcode = '22023'; end if;
 v_repeat := nullif(p_content->>'repeat', '');
 if v_repeat is not null and v_repeat not in ('daily', 'weekdays', 'weekly', 'biweekly', 'monthly') then
  raise exception 'Repetição inválida' using errcode = '22023';
 end if;
 begin
  v_publish := nullif(p_content->>'publish_at', '')::timestamptz;
  v_expires := nullif(p_content->>'expires_at', '')::timestamptz;
 exception when others then
  raise exception 'Data inválida' using errcode = '22023';
 end;
 -- No ar, a publicação não muda; num agendamento que já passou, vale agora.
 if not v_new and old_status = 'live' then v_publish := n.publish_at;
 elsif not coalesce(p_publish, true) then v_publish := null;
 elsif v_publish is null or v_publish < now() then v_publish := now();
 end if;
 if v_expires is not null and v_expires <= coalesce(v_publish, now()) then
  raise exception 'A saída do ar precisa ser depois da publicação.' using errcode = '22023';
 end if;
 if jsonb_typeof(coalesce(p_content->'targets', '[]')) <> 'array'
  or jsonb_typeof(coalesce(p_content->'exclude', '[]')) <> 'array' then
  raise exception 'Público inválido' using errcode = '22023';
 end if;

 if v_new then
  insert into public.notices(company_id, created_by, title, body, level)
  values (p_company, auth.uid(), v_title, v_body, v_level) returning * into n;
 end if;
 update public.notices set title = v_title, body = v_body, level = v_level,
  popup = coalesce((p_content->>'popup')::boolean, false),
  inbox = coalesce((p_content->>'inbox')::boolean, false),
  push = coalesce((p_content->>'push')::boolean, false),
  banner = coalesce((p_content->>'banner')::boolean, false),
  pinned = coalesce((p_content->>'pinned')::boolean, false),
  require_ack = coalesce((p_content->>'require_ack')::boolean, false),
  publish_at = v_publish, expires_at = v_expires,
  repeat = case when v_publish is null then null else v_repeat end,
  round = case when not v_new and old_status = 'live' and coalesce(p_renotify, false) then round + 1 else round end,
  version = case when v_new then version else version + 1 end,
  updated_at = now(), updated_by = auth.uid()
 where id = n.id returning * into n;
 update public.notices set next_repeat = mavi_private.notice_next_repeat(n) where id = n.id returning * into n;

 -- O público, conferido alvo a alvo.
 delete from public.notice_targets where notice_id = n.id;
 for x in select * from jsonb_array_elements(coalesce(p_content->'targets', '[]')) loop
  v_kind := x->>'kind';
  if v_kind not in ('everyone', 'user', 'team', 'client', 'project') then
   raise exception 'Público inválido' using errcode = '22023';
  end if;
  v_id := case when v_kind = 'everyone' then null else nullif(x->>'id', '')::uuid end;
  if v_kind <> 'everyone' and v_id is null then raise exception 'Público inválido' using errcode = '22023'; end if;
  v_mode := case when v_kind in ('client', 'project') then coalesce(nullif(x->>'mode', ''), 'both') end;
  if v_mode is not null and v_mode not in ('teams', 'assignees', 'both') then
   raise exception 'Público inválido' using errcode = '22023';
  end if;
  if not mavi_private.notice_target_ok(p_company, v_kind, v_id) then
   raise exception 'Você não pode avisar este público.' using errcode = '42501';
  end if;
  insert into public.notice_targets(company_id, notice_id, kind, target_id, mode)
  values (p_company, n.id, v_kind, v_id, v_mode) on conflict do nothing;
  v_targets := v_targets + 1;
 end loop;
 if v_targets = 0 then raise exception 'Escolha quem recebe o aviso.' using errcode = '22023'; end if;
 for x in select * from jsonb_array_elements(coalesce(p_content->'exclude', '[]')) loop
  v_id := nullif(x #>> '{}', '')::uuid;
  if v_id is null or not mavi_private.notice_target_ok(p_company, 'exclude', v_id) then
   raise exception 'Pessoa inválida nas exclusões' using errcode = '22023';
  end if;
  insert into public.notice_targets(company_id, notice_id, kind, target_id)
  values (p_company, n.id, 'exclude', v_id) on conflict do nothing;
 end loop;

 if mavi_private.notice_status(n) = 'live' then
  if not v_new and old_status = 'live' then
   -- Quem saiu do público (ou foi excluído) deixa de ver o aviso.
   v_audience := array(select mavi_private.notice_audience(n.id));
   delete from public.notice_receipts r where r.notice_id = n.id and not (r.user_id = any(v_audience));
   delete from public.notifications x where x.notice_id = n.id
    and not exists (select 1 from public.notice_receipts r where r.notice_id = n.id and r.user_id = x.user_id);
   -- O texto novo também na caixa de entrada.
   update public.notifications set title = left(n.title, 300), body = nullif(mavi_private.notice_excerpt(n), '')
   where notice_id = n.id;
  end if;
  perform mavi_private.notice_deliver(n.id);
 end if;
 if not v_new then perform mavi_private.notice_changed(p_company, n.id); end if;
 return jsonb_build_object('id', n.id, 'status', mavi_private.notice_status(n), 'version', n.version);
end $$;

-- Encerra agora (sai do ar; um agendado não sai mais).
create function public.end_notice(p_notice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare n public.notices; begin
 select * into n from public.notices where id = p_notice for update;
 if not found or not mavi_private.notice_can_edit(n) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if n.archived_at is not null then return; end if;
 update public.notices set archived_at = now(), archived_by = auth.uid(), version = version + 1, updated_at = now()
 where id = n.id;
 perform mavi_private.notice_changed(n.company_id, n.id);
end $$;

-- Apaga o aviso com tudo o que é dele; devolve os arquivos enviados a remover do bucket.
create function public.delete_notice(p_notice uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare n public.notices; paths text[]; begin
 select * into n from public.notices where id = p_notice for update;
 if not found or not mavi_private.notice_can_edit(n) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select coalesce(array_agg(path), '{}') into paths from public.notice_attachments
 where company_id = n.company_id and notice_id = n.id and path is not null;
 delete from public.notices where id = n.id;
 perform mavi_private.notice_changed(n.company_id, n.id);
 return paths;
end $$;

-- ------------------------------------------------------------ ler
-- Os avisos no ar da pessoa (popup, faixa, contador do Mural).
create function public.my_live_notices(p_company uuid)
returns table(id uuid, title text, body text, level text, popup boolean, banner boolean, pinned boolean,
 require_ack boolean, round integer, publish_at timestamptz, expires_at timestamptz, author_name text,
 delivered_at timestamptz, seen_at timestamptz, acked_at timestamptz, snoozed_until timestamptz,
 banner_closed_at timestamptz, attachments integer)
language sql stable security definer set search_path = '' as $$
 select n.id, n.title, n.body, n.level, n.popup, n.banner, n.pinned, n.require_ack, n.round, n.publish_at,
  n.expires_at, mavi_private.member_name(n.company_id, n.created_by), r.delivered_at, r.seen_at, r.acked_at,
  r.snoozed_until, r.banner_closed_at,
  (select count(*)::integer from public.notice_attachments a where a.notice_id = n.id and a.status = 'ready')
 from public.notice_receipts r
 join public.notices n on n.id = r.notice_id and n.round = r.round
 where r.company_id = p_company and r.user_id = auth.uid() and mavi_private.member(p_company)
  and mavi_private.notice_status(n) = 'live'
 order by case n.level when 'critical' then 0 when 'important' then 1 else 2 end, r.delivered_at desc
 limit 50
$$;

-- A página do Mural ("Para mim"): o que a pessoa recebeu, fixados no ar
-- primeiro. Busca por todas as palavras, sem acento.
create function public.my_notice_feed(p_company uuid, p_query text default '', p_limit integer default 20,
 p_offset integer default 0)
returns table(id uuid, title text, excerpt text, level text, status text, pinned boolean, require_ack boolean,
 publish_at timestamptz, expires_at timestamptz, author_name text, delivered_at timestamptz, seen_at timestamptz,
 acked_at timestamptz, attachments integer)
language sql stable security definer set search_path = '' as $$
 with q as (select coalesce(array_agg(w), '{}') as words
  from regexp_split_to_table(mavi_private.fold(coalesce(p_query, '')), '\s+') w where w <> '')
 select n.id, n.title, mavi_private.notice_excerpt(n), n.level, mavi_private.notice_status(n),
  n.pinned, n.require_ack, n.publish_at, n.expires_at, mavi_private.member_name(n.company_id, n.created_by),
  r.delivered_at, r.seen_at, r.acked_at,
  (select count(*)::integer from public.notice_attachments a where a.notice_id = n.id and a.status = 'ready')
 from public.notice_receipts r
 join public.notices n on n.id = r.notice_id
 cross join q
 where r.company_id = p_company and r.user_id = auth.uid() and mavi_private.member(p_company)
  and not exists (select 1 from unnest(q.words) w where position(w in n.search) = 0)
 order by (n.pinned and mavi_private.notice_status(n) = 'live') desc, r.delivered_at desc, n.id
 limit least(greatest(coalesce(p_limit, 20), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
$$;

-- "Enviados": os avisos que a pessoa criou (administradores: todos), com a
-- entrega da rodada atual.
create function public.sent_notices(p_company uuid, p_query text default '', p_limit integer default 20,
 p_offset integer default 0)
returns table(id uuid, title text, excerpt text, level text, status text, pinned boolean, popup boolean,
 inbox boolean, push boolean, banner boolean, require_ack boolean, repeat text, publish_at timestamptz,
 expires_at timestamptz, created_by uuid, author_name text, updated_at timestamptz, delivered integer,
 seen integer, acked integer)
language sql stable security definer set search_path = '' as $$
 with q as (select coalesce(array_agg(w), '{}') as words
  from regexp_split_to_table(mavi_private.fold(coalesce(p_query, '')), '\s+') w where w <> '')
 select n.id, n.title, mavi_private.notice_excerpt(n), n.level, mavi_private.notice_status(n), n.pinned,
  n.popup, n.inbox, n.push, n.banner, n.require_ack, n.repeat, n.publish_at, n.expires_at, n.created_by,
  mavi_private.member_name(n.company_id, n.created_by), n.updated_at,
  coalesce(s.delivered, 0), coalesce(s.seen, 0), coalesce(s.acked, 0)
 from public.notices n
 cross join q
 left join lateral (
  select count(*)::integer as delivered, count(r.seen_at)::integer as seen, count(r.acked_at)::integer as acked
  from public.notice_receipts r where r.notice_id = n.id and r.round = n.round) s on true
 where n.company_id = p_company and mavi_private.leader(p_company)
  and (n.created_by = auth.uid() or mavi_private.admin(p_company))
  and not exists (select 1 from unnest(q.words) w where position(w in n.search) = 0)
 order by n.updated_at desc, n.id
 limit least(greatest(coalesce(p_limit, 20), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
$$;

-- Um aviso inteiro: conteúdo, anexos, o que a pessoa já fez e, para quem
-- edita, o público.
create function public.notice_detail(p_notice uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n public.notices; r public.notice_receipts; v_edit boolean; begin
 select * into n from public.notices where id = p_notice;
 if not found or not mavi_private.notice_can_see(n) then return null; end if;
 v_edit := mavi_private.notice_can_edit(n);
 select * into r from public.notice_receipts where notice_id = n.id and user_id = auth.uid();
 return jsonb_build_object(
  'id', n.id, 'company_id', n.company_id, 'title', n.title, 'body', n.body, 'level', n.level,
  'popup', n.popup, 'inbox', n.inbox, 'push', n.push, 'banner', n.banner, 'pinned', n.pinned,
  'require_ack', n.require_ack, 'publish_at', n.publish_at, 'expires_at', n.expires_at, 'repeat', n.repeat,
  'next_repeat', n.next_repeat, 'round', n.round, 'status', mavi_private.notice_status(n),
  'created_by', n.created_by, 'author_name', mavi_private.member_name(n.company_id, n.created_by),
  'created_at', n.created_at, 'updated_at', n.updated_at, 'version', n.version, 'can_edit', v_edit,
  'receipt', case when r.notice_id is null or r.round <> n.round then null else jsonb_build_object(
   'delivered_at', r.delivered_at, 'seen_at', r.seen_at, 'acked_at', r.acked_at,
   'snoozed_until', r.snoozed_until, 'banner_closed_at', r.banner_closed_at) end,
  'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name,
    'content_type', a.content_type, 'size_bytes', a.size_bytes, 'source', a.source) order by a.position, a.created_at)
   from public.notice_attachments a where a.notice_id = n.id and a.status = 'ready'), '[]'),
  'targets', case when v_edit then coalesce((select jsonb_agg(jsonb_build_object('kind', t.kind, 'id', t.target_id,
    'mode', t.mode)) from public.notice_targets t where t.notice_id = n.id and t.kind <> 'exclude'), '[]') end,
  'exclude', case when v_edit then coalesce((select jsonb_agg(t.target_id) from public.notice_targets t
    where t.notice_id = n.id and t.kind = 'exclude'), '[]') end);
end $$;

-- O que a pessoa fez com o aviso: 'seen' (viu), 'ack' (Li e entendi),
-- 'snooze' (lembrar amanhã) ou 'close_banner' (fechou a faixa).
create function public.mark_notice(p_notice uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare n public.notices; v_tomorrow timestamptz; begin
 select * into n from public.notices where id = p_notice;
 if not found or not mavi_private.member(n.company_id) or not exists (
  select 1 from public.notice_receipts where notice_id = n.id and user_id = auth.uid() and round = n.round) then
  raise exception 'Aviso não encontrado.' using errcode = 'P0002';
 end if;
 if p_action = 'seen' then
  update public.notice_receipts set seen_at = coalesce(seen_at, now())
  where notice_id = n.id and user_id = auth.uid();
 elsif p_action = 'ack' then
  if not n.require_ack then raise exception 'Este aviso não pede confirmação.' using errcode = '22023'; end if;
  update public.notice_receipts set seen_at = coalesce(seen_at, now()), acked_at = coalesce(acked_at, now())
  where notice_id = n.id and user_id = auth.uid();
 elsif p_action = 'snooze' then
  select ((mavi_private.company_today(n.company_id) + 1)::timestamp) at time zone
   coalesce((select timezone from public.companies where id = n.company_id), 'America/Sao_Paulo') into v_tomorrow;
  update public.notice_receipts set seen_at = coalesce(seen_at, now()), snoozed_until = v_tomorrow
  where notice_id = n.id and user_id = auth.uid();
 elsif p_action = 'close_banner' then
  update public.notice_receipts set seen_at = coalesce(seen_at, now()), banner_closed_at = coalesce(banner_closed_at, now())
  where notice_id = n.id and user_id = auth.uid();
 else
  raise exception 'Ação inválida' using errcode = '22023';
 end if;
 -- Visto no Mural também é lido na caixa de entrada.
 update public.notifications set read_at = now()
 where notice_id = n.id and user_id = auth.uid() and read_at is null;
end $$;

-- ------------------------------------------------------------ anexos
create function public.prepare_notice_attachment(p_notice uuid, p_name text, p_size bigint, p_content_type text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare n public.notices; v_id uuid := gen_random_uuid(); v_type text; begin
 select * into n from public.notices where id = p_notice;
 if not found or not mavi_private.notice_can_edit(n) then
  raise exception 'Sem permissão para anexar arquivos a este aviso.' using errcode = '42501';
 end if;
 if p_size is null or p_size < 1 or p_size > 524288000 then raise exception 'Envie arquivos de até 500 MB.' using errcode = '22023'; end if;
 if length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'Arquivo sem nome' using errcode = '22023'; end if;
 if (select count(*) from public.notice_attachments where notice_id = n.id) >= 20 then
  raise exception 'Um aviso pode ter até 20 anexos.' using errcode = '22023';
 end if;
 v_type := lower(coalesce(nullif(btrim(p_content_type), ''), 'application/octet-stream'));
 if v_type !~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$' then v_type := 'application/octet-stream'; end if;
 -- Envios que ficaram pela metade (mais de um dia) somem da lista.
 delete from public.notice_attachments where created_by = auth.uid() and status = 'uploading'
  and created_at < now() - interval '1 day';
 insert into public.notice_attachments(id, company_id, notice_id, source, name, content_type, size_bytes, path,
  position, created_by)
 values (v_id, n.company_id, n.id, 'upload', left(btrim(p_name), 255), v_type, p_size,
  'notices/' || n.company_id || '/' || n.id || '/' || v_id,
  coalesce((select max(position) + 1 from public.notice_attachments where notice_id = n.id), 0), auth.uid());
 return v_id;
end $$;

-- Onde enviar (só no servidor, que assina o PUT).
create function public.notice_upload_target(p_attachment uuid)
returns table(path text, content_type text, size_bytes bigint)
language sql stable security definer set search_path = '' as $$
 select a.path, a.content_type, a.size_bytes from public.notice_attachments a
 where a.id = p_attachment and a.created_by = auth.uid() and a.status = 'uploading' and a.source = 'upload'
  and a.created_at > now() - interval '1 day' and mavi_private.member(a.company_id)
$$;

create function public.confirm_notice_attachment(p_attachment uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 update public.notice_attachments set status = 'ready'
 where id = p_attachment and created_by = auth.uid() and status = 'uploading';
 if not found then raise exception 'Anexo não encontrado' using errcode = '42501'; end if;
end $$;

-- Um arquivo que já está no Drive (que quem anexa pode abrir).
create function public.add_notice_drive_file(p_notice uuid, p_file uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare n public.notices; f public.drive_files; v_id uuid; begin
 select * into n from public.notices where id = p_notice;
 if not found or not mavi_private.notice_can_edit(n) then
  raise exception 'Sem permissão para anexar arquivos a este aviso.' using errcode = '42501';
 end if;
 select * into f from public.drive_files where id = p_file and company_id = n.company_id and status = 'ready';
 if not found or not (mavi_private.drive_can_read(f.company_id, f.client_id)
  or mavi_private.drive_folder_shared(f.company_id, f.folder_id)) then
  raise exception 'Arquivo não encontrado no Drive.' using errcode = 'P0002';
 end if;
 if (select count(*) from public.notice_attachments where notice_id = n.id) >= 20 then
  raise exception 'Um aviso pode ter até 20 anexos.' using errcode = '22023';
 end if;
 insert into public.notice_attachments(company_id, notice_id, source, drive_file_id, name, content_type, size_bytes,
  status, position, created_by)
 values (n.company_id, n.id, 'drive', f.id, f.name, f.content_type, f.size_bytes, 'ready',
  coalesce((select max(position) + 1 from public.notice_attachments where notice_id = n.id), 0), auth.uid())
 on conflict (notice_id, drive_file_id) do update set name = excluded.name
 returning id into v_id;
 return v_id;
end $$;

-- Tira um anexo; devolve o caminho a apagar do bucket (nulo para arquivos do Drive).
create function public.delete_notice_attachment(p_attachment uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare a public.notice_attachments; n public.notices; begin
 select * into a from public.notice_attachments where id = p_attachment for update;
 if not found then raise exception 'Anexo não encontrado' using errcode = 'P0002'; end if;
 select * into n from public.notices where id = a.notice_id;
 if not mavi_private.notice_can_edit(n) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from public.notice_attachments where id = a.id;
 return a.path;
end $$;

-- Onde estão os anexos que a pessoa pode abrir (o servidor assina o GET).
create function public.notice_attachment_targets(p_ids uuid[])
returns table(id uuid, path text, name text, content_type text)
language sql stable security definer set search_path = '' as $$
 select a.id, coalesce(a.path, f.path), a.name, a.content_type
 from public.notice_attachments a
 join public.notices n on n.id = a.notice_id
 left join public.drive_files f on f.company_id = a.company_id and f.id = a.drive_file_id and f.status = 'ready'
 where a.id = any(p_ids[1:60]) and a.status = 'ready' and coalesce(a.path, f.path) is not null
  and mavi_private.notice_can_see(n)
$$;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.notice_status(public.notices), mavi_private.notice_can_edit(public.notices),
 mavi_private.notice_can_see(public.notices), mavi_private.notice_target_ok(uuid, text, uuid),
 mavi_private.notice_audience(uuid), mavi_private.notice_excerpt(public.notices),
 mavi_private.notice_search_text(), mavi_private.notice_next_repeat(public.notices),
 mavi_private.notice_push(public.notices, uuid[]), mavi_private.notice_deliver(uuid),
 mavi_private.notice_changed(uuid, uuid), mavi_private.run_notices() from public, anon, authenticated;
revoke all on function public.save_notice(uuid, uuid, jsonb, boolean, boolean, integer), public.end_notice(uuid),
 public.delete_notice(uuid), public.my_live_notices(uuid), public.my_notice_feed(uuid, text, integer, integer),
 public.sent_notices(uuid, text, integer, integer), public.notice_detail(uuid), public.mark_notice(uuid, text),
 public.prepare_notice_attachment(uuid, text, bigint, text), public.notice_upload_target(uuid),
 public.confirm_notice_attachment(uuid), public.add_notice_drive_file(uuid, uuid),
 public.delete_notice_attachment(uuid), public.notice_attachment_targets(uuid[]) from public, anon;
grant execute on function public.save_notice(uuid, uuid, jsonb, boolean, boolean, integer), public.end_notice(uuid),
 public.delete_notice(uuid), public.my_live_notices(uuid), public.my_notice_feed(uuid, text, integer, integer),
 public.sent_notices(uuid, text, integer, integer), public.notice_detail(uuid), public.mark_notice(uuid, text),
 public.prepare_notice_attachment(uuid, text, bigint, text), public.notice_upload_target(uuid),
 public.confirm_notice_attachment(uuid), public.add_notice_drive_file(uuid, uuid),
 public.delete_notice_attachment(uuid), public.notice_attachment_targets(uuid[]) to authenticated;

-- Hosted Supabase supports pg_cron; embedded PostgreSQL used in tests does not.
do $$ begin
 if exists(select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-notices', '* * * * *', 'select mavi_private.run_notices()');
 else
  raise notice 'pg_cron unavailable: schedule mavi_private.run_notices() on the hosted database';
 end if;
end $$;

commit;
