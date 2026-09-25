begin;

-- Campanhas: o que faltava para o dia a dia se parecer com o do MASO.
--  1. Conexões do Meta por perfil: cada perfil do Facebook dá acesso às
--     contas que enxerga (o token fica por conta). Agora dá para ver e
--     remover um perfil sem desconectar os outros.
--  2. Um resumo da sincronização diária, para conferir se o agendamento
--     está rodando e se os números de cada ciclo estão em dia.
--  3. Comentários da campanha (o painel "Comentários da Campanha" do MASO):
--     o que foi feito (otimização, correção ou informação), no ciclo atual.
-- Tudo exclusivo de administradores, como o resto do módulo.

-- 1. The account list now says whose profile reaches each account.
drop function public.ad_meta_account_list(uuid);
create function public.ad_meta_account_list(p_company uuid) returns table(account_id text, name text, currency text,
 account_status integer, token_expires_at timestamptz, fb_user_id text, fb_user_name text)
language plpgsql stable security definer set search_path = '' as $$ begin
 perform mavi_private.ad_require_admin(p_company);
 return query select m.account_id, m.name, m.currency, m.account_status, m.token_expires_at, m.fb_user_id,
  m.fb_user_name
  from mavi_private.ad_meta_accounts m where m.company_id = p_company order by m.fb_user_name, m.name, m.account_id;
end $$;

-- Forgets the accounts a Facebook profile connected (the others stay).
create function public.ad_disconnect_meta_profile(p_company uuid, p_fb_user_id text) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; begin
 perform mavi_private.ad_require_admin(p_company);
 delete from mavi_private.ad_meta_accounts where company_id = p_company and fb_user_id = coalesce(p_fb_user_id, '');
 get diagnostics n = row_count;
 return n;
end $$;

revoke all on function public.ad_meta_account_list(uuid), public.ad_disconnect_meta_profile(uuid, text)
 from public, anon, authenticated;
grant execute on function public.ad_meta_account_list(uuid), public.ad_disconnect_meta_profile(uuid, text)
 to authenticated;

-- 2. The daily sync at a glance: whether it is scheduled, when it last ran,
-- which cycles are due (the same rule as ad_sync_targets), how many were
-- synced today, which failed (and why), and whose numbers are up to date
-- (data up to yesterday, or to the cycle's end).
create function public.ad_sync_overview(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t date; tz text; job jsonb := null; result jsonb; begin
 perform mavi_private.ad_require_admin(p_company);
 t := mavi_private.company_today(p_company);
 tz := coalesce((select timezone from public.companies where id = p_company), 'America/Sao_Paulo');
 -- pg_cron may be missing (local databases): then there is no job to show.
 if to_regclass('cron.job') is not null then
  execute $q$
   select jsonb_build_object('schedule', j.schedule, 'active', j.active,
    'last_run', (select jsonb_build_object('status', d.status, 'start_time', d.start_time,
      'message', left(coalesce(d.return_message, ''), 300))
     from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1))
   from cron.job j where j.jobname = 'mavi-ads-sync' limit 1 $q$ into job;
 end if;
 with due as (
  select y.id, y.end_date, a.id as campaign_id, a.name as campaign
  from public.ad_cycles y
  join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id
  where y.company_id = p_company and a.platform in ('meta','google') and not a.archived
   and exists (select 1 from public.ad_cycle_links k where k.company_id = y.company_id and k.cycle_id = y.id)
   and y.start_date < t and y.end_date >= t - 8
 ), state as (
  select d.*,
   (select r.status from public.ad_sync_runs r where r.company_id = p_company and r.cycle_id = d.id
     and (r.created_at at time zone tz)::date = t order by r.created_at desc limit 1) as today_status,
   (select r.message from public.ad_sync_runs r where r.company_id = p_company and r.cycle_id = d.id
     and (r.created_at at time zone tz)::date = t order by r.created_at desc limit 1) as today_message,
   (select max(m.day) from public.ad_daily_metrics m where m.company_id = p_company and m.cycle_id = d.id
     and m.source in ('meta','google')) as last_day
  from due d
 )
 select jsonb_build_object(
  'configured', exists (select 1 from mavi_private.ad_sync_config where id),
  'job', job,
  'today', t,
  'last_schedule', (select max(r.created_at) from public.ad_sync_runs r
    where r.company_id = p_company and r.trigger = 'schedule'),
  'due', (select count(*) from state),
  'synced', (select count(*) from state where today_status = 'ok'),
  'failed', (select count(*) from state where today_status = 'error'),
  'pending', (select count(*) from state where today_status is null),
  'up_to_date', (select count(*) from state where last_day >= least(end_date, t - 1)),
  'errors', coalesce((select jsonb_agg(jsonb_build_object('campaign_id', s.campaign_id, 'campaign', s.campaign,
     'message', s.today_message) order by s.campaign) from (select * from state where today_status = 'error'
     order by campaign limit 30) s), '[]'),
  'stale', coalesce((select jsonb_agg(jsonb_build_object('campaign_id', s.campaign_id, 'campaign', s.campaign,
     'last_day', s.last_day) order by s.campaign) from (select * from state
     where last_day is null or last_day < least(end_date, t - 1) order by campaign limit 30) s), '[]')
 ) into result;
 return result;
end $$;
revoke all on function public.ad_sync_overview(uuid) from public, anon, authenticated;
grant execute on function public.ad_sync_overview(uuid) to authenticated;

-- 3. Comments of a campaign, each in the cycle current when written.
create table public.ad_campaign_comments (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 campaign_id uuid not null,
 cycle_id uuid,
 author_id uuid not null references auth.users(id),
 -- MASO's "O que você realizou?": otimização, correção ou informação.
 kind text not null check (kind in ('optimization','correction','information')),
 -- Rich text as the tasks' comments store it (src/rich-text.ts).
 body text not null check (length(body) between 1 and 20000),
 created_at timestamptz not null default now(),
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id) on delete cascade,
 foreign key (company_id, cycle_id) references public.ad_cycles(company_id, id) on delete set null (cycle_id)
);
create index ad_campaign_comments_campaign on public.ad_campaign_comments(company_id, campaign_id, created_at desc);
alter table public.ad_campaign_comments enable row level security;
create policy ad_campaign_comments_read on public.ad_campaign_comments for select to authenticated using (
 company_id in (select mavi_private.admin_companies()));
revoke all on public.ad_campaign_comments from anon, authenticated;
grant select on public.ad_campaign_comments to authenticated;

create function public.add_ad_campaign_comment(p_campaign uuid, p_kind text, p_body text)
returns public.ad_campaign_comments
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; result public.ad_campaign_comments; begin
 select * into a from public.ad_campaigns where id = p_campaign;
 if not found or not mavi_private.ad_can_write(a.company_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if p_kind not in ('optimization','correction','information') then
  raise exception 'Informe o que você realizou' using errcode = '22023';
 end if;
 if length(trim(coalesce(p_body, ''))) = 0 then
  raise exception 'Escreva o comentário' using errcode = '22023';
 end if;
 insert into public.ad_campaign_comments(company_id, campaign_id, cycle_id, author_id, kind, body)
 values (a.company_id, a.id, a.current_cycle_id, auth.uid(), p_kind, left(p_body, 20000))
 returning * into result;
 return result;
end $$;

-- Only the author removes a comment of theirs.
create function public.delete_ad_campaign_comment(p_comment uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.ad_campaign_comments; begin
 select * into c from public.ad_campaign_comments where id = p_comment;
 if not found or not mavi_private.ad_can_write(c.company_id) or c.author_id <> auth.uid() then
  raise exception 'Só quem escreveu remove o comentário' using errcode = '42501';
 end if;
 delete from public.ad_campaign_comments where id = p_comment;
end $$;

revoke all on function public.add_ad_campaign_comment(uuid, text, text), public.delete_ad_campaign_comment(uuid)
 from public, anon, authenticated;
grant execute on function public.add_ad_campaign_comment(uuid, text, text), public.delete_ad_campaign_comment(uuid)
 to authenticated;

commit;
