begin;

-- Campanhas passa a ser de administradores e gestores (antes, só de
-- administradores; decisão D-47 revista). Os colaboradores continuam fora.
-- Tudo no módulo passa pelas mesmas funções e políticas, então basta trocá-las:
--  * mavi_private.ad_require_admin: a entrada das funções de leitura, das
--    conexões com Meta e Google e da sincronização (o nome fica, por
--    compatibilidade com as funções que a chamam);
--  * mavi_private.ad_can_write: a escrita (campanhas, ciclos, registros…);
--  * mavi_private.ad_sync_allowed: o botão "Sincronizar";
--  * a volta do Facebook e do Google (ad_take_state e
--    ad_complete_meta_connect), que conferiam o papel direto;
--  * as políticas de leitura das tabelas do módulo.

create or replace function mavi_private.ad_require_admin(c uuid) returns void
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.leader(c) then
  raise exception 'Sem permissão: Campanhas é exclusivo de administradores e gestores' using errcode = '42501';
 end if;
end $$;

create or replace function mavi_private.ad_can_write(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.leader(c)
$$;

create or replace function mavi_private.ad_sync_allowed(p_secret text, c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select (p_secret is not null and exists (select 1 from mavi_private.ad_sync_config where id and secret = p_secret))
  or (c is not null and mavi_private.leader(c))
$$;

alter policy ad_campaigns_read on public.ad_campaigns
 using (company_id in (select mavi_private.leader_companies()));
alter policy ad_daily_metrics_read on public.ad_daily_metrics
 using (company_id in (select mavi_private.leader_companies()));
alter policy ad_cycle_snapshots_read on public.ad_cycle_snapshots
 using (company_id in (select mavi_private.leader_companies()));
alter policy ad_sync_runs_read on public.ad_sync_runs
 using (company_id in (select mavi_private.leader_companies()));
alter policy ad_campaign_comments_read on public.ad_campaign_comments
 using (company_id in (select mavi_private.leader_companies()));

-- The platforms' redirect (no session): whoever started the connection must
-- still be an administrator or a manager of the company.
create or replace function mavi_private.ad_take_state(p_state text, p_provider text, out company_id uuid, out user_id uuid)
language plpgsql security definer set search_path = '' as $$ begin
 delete from mavi_private.ad_oauth_states s
 where s.state = p_state and s.provider = p_provider and s.created_at > now() - interval '15 minutes'
 returning s.company_id, s.user_id into company_id, user_id;
 if company_id is null or not exists (select 1 from public.memberships m where m.company_id = ad_take_state.company_id
   and m.user_id = ad_take_state.user_id and m.active and m.role in ('admin','manager')) then
  raise exception 'Conexão expirada. Tente conectar de novo.' using errcode = '42501';
 end if;
end $$;

create or replace function public.ad_complete_meta_connect(p_state text, p_fb_user_id text, p_fb_user_name text,
 p_token_cipher text, p_expires_at timestamptz, p_accounts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st mavi_private.ad_oauth_states; accounts jsonb; pending uuid; begin
 delete from mavi_private.ad_oauth_states s
 where s.state = p_state and s.provider = 'meta' and s.created_at > now() - interval '15 minutes'
 returning * into st;
 if st.state is null or st.client_id is null or not exists (select 1 from public.memberships m
   where m.company_id = st.company_id and m.user_id = st.user_id and m.active and m.role in ('admin','manager')) then
  raise exception 'Conexão expirada. Tente conectar de novo.' using errcode = '42501';
 end if;
 if coalesce(p_token_cipher, '') !~ '^v1:' then raise exception 'Resposta do Facebook incompleta.' using errcode = '22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('account_id', a ->> 'account_id', 'name', left(coalesce(a ->> 'name', ''), 200),
   'currency', left(coalesce(a ->> 'currency', ''), 10),
   'account_status', case when coalesce(a ->> 'account_status', '') ~ '^[0-9]{1,4}$' then (a ->> 'account_status')::integer end)),
  '[]') into accounts
 from jsonb_array_elements(case when jsonb_typeof(p_accounts) = 'array' then p_accounts else '[]' end) a
 where coalesce(a ->> 'account_id', '') ~ '^[0-9]{1,30}$';
 if jsonb_array_length(accounts) = 0 then return null; end if;
 delete from mavi_private.ad_meta_pending where created_at < now() - interval '1 hour'
  or (company_id = st.company_id and user_id = st.user_id);
 insert into mavi_private.ad_meta_pending(company_id, client_id, campaign_id, user_id, fb_user_id, fb_user_name,
  token_cipher, token_expires_at, accounts)
 values (st.company_id, st.client_id, st.campaign_id, st.user_id, left(coalesce(p_fb_user_id, ''), 40),
  left(coalesce(p_fb_user_name, ''), 200), p_token_cipher, p_expires_at, accounts)
 returning id into pending;
 return jsonb_build_object('pending', pending, 'campaign', st.campaign_id);
end $$;

commit;
