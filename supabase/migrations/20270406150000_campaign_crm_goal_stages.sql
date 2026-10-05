begin;

-- Campanhas › Insights da MAVI: as etapas que importam (pedido de
-- 04/10/2026, evolução da Fase 6).
--
-- * Mais de uma etapa do CRM, cada uma com a sua meta de custo por lead
--   (opcional): ex.: Qualificado até R$ 30, Negociação até R$ 80, Ganho até
--   R$ 400. A MAVI mede o custo por lead em cada uma e diz onde o funil
--   estoura.
-- * Padrão do cliente (o funil do CRM é dele) com ajuste por campanha: a
--   campanha usa as próprias etapas, se tiver; senão, as do cliente.
-- * Substitui ad_campaign_crm_goals (uma etapa por campanha): as que existem
--   viram o ajuste da campanha.

create table public.ad_crm_goals (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 client_id uuid,
 campaign_id uuid,
 -- [{pipeline_id, pipeline_name, stage_id, stage_name, cost_goal}]
 stages jsonb not null check (jsonb_typeof(stages) = 'array' and jsonb_array_length(stages) between 1 and 6),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now(),
 check ((client_id is null) <> (campaign_id is null)),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade,
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id) on delete cascade
);
create unique index ad_crm_goals_client on public.ad_crm_goals(company_id, client_id) where client_id is not null;
create unique index ad_crm_goals_campaign on public.ad_crm_goals(company_id, campaign_id) where campaign_id is not null;
alter table public.ad_crm_goals enable row level security;
revoke all on public.ad_crm_goals from public, anon, authenticated;

insert into public.ad_crm_goals(company_id, campaign_id, stages, updated_by, updated_at)
select g.company_id, g.campaign_id, jsonb_build_array(jsonb_build_object('pipeline_id', g.pipeline_id,
 'pipeline_name', g.pipeline_name, 'stage_id', g.stage_id, 'stage_name', g.stage_name, 'cost_goal', g.cost_goal)),
 g.updated_by, g.updated_at
from public.ad_campaign_crm_goals g;
drop table public.ad_campaign_crm_goals;

-- As etapas como chegam da tela: até 6, sem repetir, cada uma com o funil, o
-- nome e a meta (opcional, maior que zero).
create function mavi_private.crm_goal_stages(v jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare x jsonb; v_out jsonb := '[]'; v_seen text[] := '{}'; v_cost numeric; begin
 if v is null or jsonb_typeof(v) <> 'array' then return '[]'; end if;
 if jsonb_array_length(v) > 6 then
  raise exception 'Escolha até 6 etapas.' using errcode = '22023';
 end if;
 for x in select * from jsonb_array_elements(v) loop
  if jsonb_typeof(x) <> 'object' or coalesce(x->>'stage_id', '') !~* '^[0-9a-f-]{36}$'
   or coalesce(x->>'pipeline_id', '') !~* '^[0-9a-f-]{36}$' or length(btrim(coalesce(x->>'stage_name', ''))) = 0 then
   raise exception 'Escolha as etapas do funil.' using errcode = '22023';
  end if;
  continue when lower(x->>'stage_id') = any(v_seen);
  v_seen := v_seen || lower(x->>'stage_id');
  v_cost := case when coalesce(x->>'cost_goal', '') = '' then null else (x->>'cost_goal')::numeric end;
  if v_cost is not null and v_cost <= 0 then
   raise exception 'A meta de custo precisa ser maior que zero.' using errcode = '22023';
  end if;
  v_out := v_out || jsonb_build_array(jsonb_build_object('pipeline_id', x->>'pipeline_id',
   'pipeline_name', left(btrim(coalesce(x->>'pipeline_name', '')), 200), 'stage_id', x->>'stage_id',
   'stage_name', left(btrim(x->>'stage_name'), 200), 'cost_goal', round(v_cost, 2)));
 end loop;
 return v_out;
end $$;

-- As etapas que valem na campanha: as dela ou, sem elas, as do cliente.
-- source: 'campaign' | 'client'; client_stages: o padrão do cliente (para a
-- tela mostrar o que a campanha está ajustando). Nulo: nenhuma.
create or replace function mavi_private.campaign_crm_goal_json(c uuid, p_campaign uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 with k as (select mavi_private.ad_campaign_client(p_campaign) as client),
 own as (select g.* from public.ad_crm_goals g where g.company_id = c and g.campaign_id = p_campaign),
 def as (select g.* from public.ad_crm_goals g, k where g.company_id = c and g.client_id = k.client)
 select case
  when exists (select 1 from own) then (select jsonb_build_object('source', 'campaign', 'stages', o.stages,
    'client_stages', (select d.stages from def d), 'updated_at', o.updated_at,
    'updated_by_name', (select m.name from public.memberships m where m.company_id = c and m.user_id = o.updated_by))
   from own o)
  when exists (select 1 from def) then (select jsonb_build_object('source', 'client', 'stages', d.stages,
    'client_stages', d.stages, 'updated_at', d.updated_at,
    'updated_by_name', (select m.name from public.memberships m where m.company_id = c and m.user_id = d.updated_by))
   from def d)
 end
$$;

-- Grava as etapas do cliente (padrão de todas as campanhas dele) ou só desta
-- campanha. Sem etapas: tira (a campanha volta ao padrão do cliente).
drop function public.set_campaign_crm_goal(uuid, uuid, jsonb);
create function public.set_campaign_crm_goal(p_company uuid, p_campaign uuid, p_goal jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_scope text := coalesce(p_goal->>'scope', 'campaign'); v_stages jsonb; v_client uuid; begin
 if not mavi_private.campaign_insight_reader(p_company, p_campaign) or not mavi_private.ad_can_write(p_company) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if v_scope not in ('client', 'campaign') then raise exception 'Alcance inválido.' using errcode = '22023'; end if;
 v_stages := mavi_private.crm_goal_stages(p_goal->'stages');
 v_client := mavi_private.ad_campaign_client(p_campaign);
 if v_scope = 'client' then
  if jsonb_array_length(v_stages) = 0 then
   delete from public.ad_crm_goals where company_id = p_company and client_id = v_client;
  else
   insert into public.ad_crm_goals as g (company_id, client_id, stages, updated_by, updated_at)
   values (p_company, v_client, v_stages, auth.uid(), now())
   on conflict (company_id, client_id) where client_id is not null do update set stages = excluded.stages,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
   -- Definir o padrão do cliente a partir de uma campanha: ela passa a usá-lo.
   delete from public.ad_crm_goals where company_id = p_company and campaign_id = p_campaign;
  end if;
 elsif jsonb_array_length(v_stages) = 0 then
  delete from public.ad_crm_goals where company_id = p_company and campaign_id = p_campaign;
 else
  insert into public.ad_crm_goals as g (company_id, campaign_id, stages, updated_by, updated_at)
  values (p_company, p_campaign, v_stages, auth.uid(), now())
  on conflict (company_id, campaign_id) where campaign_id is not null do update set stages = excluded.stages,
   updated_by = excluded.updated_by, updated_at = excluded.updated_at;
 end if;
 return mavi_private.campaign_crm_goal_json(p_company, p_campaign);
end $$;
grant execute on function public.set_campaign_crm_goal(uuid, uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
