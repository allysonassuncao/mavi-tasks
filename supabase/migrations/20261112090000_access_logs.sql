begin;

-- Logs de login e acesso de cada pessoa, vistos por administradores e
-- gestores em Equipe e configurações › Pessoas do espaço.
--  • login  — o Supabase Auth abriu uma sessão (senha, link de convite ou de
--             recuperação…): gatilho em auth.sessions, com IP e navegador que
--             o próprio Auth viu, e o método em auth.mfa_amr_claims.
--  • logout — a sessão foi encerrada (Sair, troca de senha, expiração).
--  • access — a pessoa abriu o sistema num espaço (log_access, chamado pelo
--             app ao abrir e ao voltar para a aba; no máximo 1 a cada 30 min).
-- O login não pertence a um espaço (company_id nulo): aparece para os líderes
-- de qualquer espaço da pessoa; o acesso aparece só no espaço aberto.

create table public.access_logs (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 company_id uuid references public.companies(id) on delete cascade,
 kind text not null check (kind in ('login', 'logout', 'access')),
 method text,
 ip text,
 user_agent text,
 session_id uuid,
 created_at timestamptz not null default now()
);
create index access_logs_user on public.access_logs(user_id, id desc);
create index access_logs_session on public.access_logs(session_id) where session_id is not null;
create index access_logs_created on public.access_logs(created_at);
alter table public.access_logs enable row level security;
revoke all on public.access_logs from public, anon, authenticated;

-- Um erro aqui nunca impede ninguém de entrar ou sair: o log é descartado.
create function mavi_private.log_auth_session() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
begin
 begin
  insert into public.access_logs(user_id, kind, ip, user_agent, session_id)
  values ((s->>'user_id')::uuid, case when tg_op = 'DELETE' then 'logout' else 'login' end,
   left(nullif(split_part(s->>'ip', '/', 1), ''), 64), left(nullif(s->>'user_agent', ''), 300),
   (s->>'id')::uuid);
 exception when others then null;
 end;
 return null;
end $$;

create function mavi_private.log_auth_method() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 begin
  update public.access_logs set method = left(new.authentication_method::text, 40)
  where session_id = new.session_id and kind = 'login' and method is null;
 exception when others then null;
 end;
 return null;
end $$;
revoke all on function mavi_private.log_auth_session(), mavi_private.log_auth_method()
 from public, anon, authenticated;

do $$ begin
 if to_regclass('auth.sessions') is not null then
  create trigger mavi_access_log after insert or delete on auth.sessions
   for each row execute function mavi_private.log_auth_session();
 else
  raise notice 'auth.sessions ausente: logins não serão registrados';
 end if;
 if to_regclass('auth.mfa_amr_claims') is not null then
  create trigger mavi_access_log_method after insert on auth.mfa_amr_claims
   for each row execute function mavi_private.log_auth_method();
 end if;
exception when insufficient_privilege then
 raise notice 'Sem permissão para gatilhos em auth.sessions: logins não serão registrados';
end $$;

-- A pessoa abriu o sistema no espaço: registrado com o IP e o navegador vistos
-- pelo gateway, uma vez a cada 30 minutos por espaço.
create function public.log_access(p_company uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); o jsonb;
begin
 if u is null or p_company is null
  or not exists (select 1 from public.memberships where company_id = p_company and user_id = u and active)
  or exists (select 1 from public.access_logs where user_id = u and company_id = p_company
   and kind = 'access' and created_at > now() - interval '30 minutes') then
  return;
 end if;
 o := coalesce(mavi_private.request_client(), '{}');
 insert into public.access_logs(user_id, company_id, kind, ip, user_agent)
 values (u, p_company, 'access', left(o->>'ip', 64), o->>'user_agent');
end $$;
revoke all on function public.log_access(uuid) from public, anon;
grant execute on function public.log_access(uuid) to authenticated;

-- Histórico de uma pessoa, do mais recente ao mais antigo (p_before pagina com
-- o último id). Administradores veem todos; gestores, quem não é administrador
-- (e a si mesmos). Na primeira página vem também o resumo.
create function public.member_access_logs(p_company uuid, p_user uuid, p_kind text default null,
 p_before bigint default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_role text; n integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_items jsonb; v_summary jsonb;
begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores veem os acessos.' using errcode = '42501';
 end if;
 select role into v_role from public.memberships where company_id = p_company and user_id = p_user;
 if v_role is null then
  raise exception 'Usuário não encontrado na empresa';
 end if;
 if v_role = 'admin' and p_user <> auth.uid() and not mavi_private.admin(p_company) then
  raise exception 'Somente administradores veem os acessos de outro administrador.' using errcode = '42501';
 end if;
 if p_kind is not null and p_kind not in ('login', 'logout', 'access') then
  raise exception 'Tipo de registro inválido' using errcode = '22023';
 end if;

 select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc), '[]') into v_items from (
  select l.id, l.kind, l.method, l.ip, l.user_agent, l.created_at,
   case when l.kind = 'logout' then (select s.created_at from public.access_logs s
    where s.session_id = l.session_id and s.kind = 'login' and s.user_id = l.user_id
    order by s.id limit 1) end as session_started_at
  from public.access_logs l
  where l.user_id = p_user and (l.company_id is null or l.company_id = p_company)
   and (p_kind is null or l.kind = p_kind) and (p_before is null or l.id < p_before)
  order by l.id desc limit n) r;

 if p_before is null then
  select jsonb_build_object(
   'last_login', max(created_at) filter (where kind = 'login'),
   'last_access', max(created_at) filter (where kind in ('login', 'access')),
   'logins_30d', count(*) filter (where kind = 'login' and created_at > now() - interval '30 days'),
   'ips_30d', count(distinct ip) filter (where kind in ('login', 'access') and created_at > now() - interval '30 days'),
   'devices_30d', count(distinct user_agent) filter (where kind in ('login', 'access') and created_at > now() - interval '30 days'))
  into v_summary
  from public.access_logs
  where user_id = p_user and (company_id is null or company_id = p_company) and kind in ('login', 'access');
 end if;
 return jsonb_build_object('items', v_items, 'summary', v_summary);
end $$;
revoke all on function public.member_access_logs(uuid, uuid, text, bigint, integer) from public, anon;
grant execute on function public.member_access_logs(uuid, uuid, text, bigint, integer) to authenticated;

-- Guardados por um ano.
do $$ begin
 if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-access-log-retention', '40 3 * * *',
   $job$delete from public.access_logs where created_at < now() - interval '1 year'$job$);
 else
  raise notice 'pg_cron unavailable: retention must be scheduled on the hosted database';
 end if;
end $$;

commit;
