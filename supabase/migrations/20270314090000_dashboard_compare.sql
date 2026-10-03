-- Comparação nos Dashboards: cada painel também calcula as mesmas consultas
-- num segundo período (o de comparação), escolhido no dashboard — período
-- anterior, mesmo período do mês passado ou datas próprias. Vale no app e no
-- link compartilhado; o navegador resolve as datas e manda p_cmp_from/p_cmp_to.
--
-- dashboard_run ganha o período de comparação: as consultas voltam em
-- "compare" com todos os grupos (sem o top N, para o navegador achar cada
-- categoria mostrada e somar "Outros") e com o intervalo do período, para as
-- barras/pontos se alinharem (1º com 1º). "previous" (o Número que compara
-- com o período anterior) só é calculado quando não há comparação.

create or replace function mavi_private.dashboard_run(c uuid, spec jsonb, p_from date, p_to date, p_filters jsonb,
 p_cmp_from date, p_cmp_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q jsonb;
  series jsonb := '{}';
  previous jsonb := '{}';
  cmp jsonb := '{}';
  grp text := coalesce(spec->>'groupBy', 'none');
  iv text := coalesce(spec->>'interval', 'auto');
  days integer;
  lim integer;
  has_cmp boolean := p_cmp_from is not null or p_cmp_to is not null;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Período inválido' using errcode = '22023';
  end if;
  if has_cmp and (p_cmp_from is null or p_cmp_to is null or p_cmp_to < p_cmp_from or p_cmp_to - p_cmp_from > 3700) then
    raise exception 'Período de comparação inválido' using errcode = '22023';
  end if;
  days := p_to - p_from + 1;
  if jsonb_typeof(spec->'queries') <> 'array' or jsonb_array_length(spec->'queries') not between 1 and 5 then
    raise exception 'Cada painel tem de 1 a 5 consultas' using errcode = '22023';
  end if;
  if iv = 'auto' then iv := case when days <= 62 then 'day' when days <= 366 then 'week' else 'month' end; end if;
  if grp = 'time' and iv = 'day' and days > 400 then
    raise exception 'Para períodos acima de 400 dias, agrupe por semana ou mês.' using errcode = '22023';
  end if;
  if has_cmp and grp = 'time' and iv = 'day' and p_cmp_to - p_cmp_from >= 400 then
    raise exception 'Para comparar com períodos acima de 400 dias, agrupe por semana ou mês.' using errcode = '22023';
  end if;
  lim := case when coalesce(spec->'formula'->>'expr', '') <> '' then null
    else least(greatest(coalesce((spec->>'limit')::integer, 10), 1), 50) end;
  for q in select value from jsonb_array_elements(spec->'queries') loop
    if coalesce(q->>'ref', '') !~ '^[A-E]$' then raise exception 'Consulta inválida' using errcode = '22023'; end if;
    series := series || jsonb_build_object(q->>'ref',
     mavi_private.dashboard_series(c, q, grp, iv, p_from, p_to, p_filters, lim));
    if has_cmp then
      cmp := cmp || jsonb_build_object(q->>'ref',
       mavi_private.dashboard_series(c, q, grp, iv, p_cmp_from, p_cmp_to, p_filters, null));
    elsif grp = 'none' and coalesce((spec->>'compare')::boolean, false) then
      previous := previous || jsonb_build_object(q->>'ref',
       mavi_private.dashboard_series(c, q, grp, iv, p_from - days, p_from - 1, p_filters, lim));
    end if;
  end loop;
  return jsonb_build_object('series', series, 'previous', previous, 'interval', iv)
   || case when has_cmp then jsonb_build_object('compare', cmp,
     'compare_range', jsonb_build_object('from', p_cmp_from, 'to', p_cmp_to)) else '{}'::jsonb end;
end $$;
revoke all on function mavi_private.dashboard_run(uuid, jsonb, date, date, jsonb, date, date) from public, anon, authenticated;

-- A forma antiga (sem comparação) segue valendo para quem a chama.
create or replace function mavi_private.dashboard_run(c uuid, spec jsonb, p_from date, p_to date, p_filters jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select mavi_private.dashboard_run(c, spec, p_from, p_to, p_filters, null, null);
$$;
revoke all on function mavi_private.dashboard_run(uuid, jsonb, date, date, jsonb) from public, anon, authenticated;

-- Os dados de um painel salvo (app ou link), agora com a comparação; o cache
-- de 60 segundos separa cada período de comparação.
drop function public.dashboard_panel_data(uuid, text, date, date, jsonb, text, text, boolean);
create function public.dashboard_panel_data(p_dashboard uuid, p_panel text, p_from date, p_to date,
 p_vars jsonb default null, p_token text default null, p_password text default null, p_fresh boolean default false,
 p_cmp_from date default null, p_cmp_to date default null)
 returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare d public.dashboards; acc text; panel jsonb; filters jsonb; key text; hit jsonb; result jsonb; begin
  if p_token is not null then select * into d from public.dashboards where share_token = p_token;
  else select * into d from public.dashboards where id = p_dashboard; end if;
  if not found then raise exception 'Dashboard não encontrado' using errcode = '42501'; end if;
  acc := mavi_private.dashboard_access(d, p_token, p_password);
  if acc = 'locked' then return jsonb_build_object('error', 'Muitas tentativas. Tente novamente em alguns minutos.'); end if;
  if acc = 'password' then return jsonb_build_object('error', 'Senha incorreta.'); end if;
  if acc is null then raise exception 'Sem acesso a este dashboard' using errcode = '42501'; end if;
  select value into panel from jsonb_array_elements(d.panels) where value->>'id' = p_panel;
  if panel is null then raise exception 'Painel não encontrado' using errcode = 'P0002'; end if;
  filters := mavi_private.dashboard_scoped(coalesce(case when acc = 'editor' and p_vars is not null
   then p_vars->'filters' end, d.variables->'filters', '{}'::jsonb), mavi_private.dashboard_scope(d));
  key := md5(concat_ws('|', d.id, d.version, p_panel, p_from, p_to, filters::text,
   coalesce(p_cmp_from::text, '-'), coalesce(p_cmp_to::text, '-')));
  if not (p_fresh and auth.uid() is not null) then
    select data into hit from mavi_private.dashboard_cache
    where cache_key = key and created_at > now() - interval '60 seconds';
    if hit is not null then return hit; end if;
  end if;
  result := mavi_private.dashboard_run(d.company_id, panel->'spec', p_from, p_to, filters, p_cmp_from, p_cmp_to)
   || jsonb_build_object('computed_at', now());
  insert into mavi_private.dashboard_cache(cache_key, dashboard_id, created_at, data) values (key, d.id, now(), result)
  on conflict (cache_key) do update set created_at = excluded.created_at, data = excluded.data;
  return result;
end $$;
revoke all on function public.dashboard_panel_data(uuid, text, date, date, jsonb, text, text, boolean, date, date) from public;
grant execute on function public.dashboard_panel_data(uuid, text, date, date, jsonb, text, text, boolean, date, date)
 to anon, authenticated;

-- A prévia do editor (e a MAVI dos Dashboards), também com a comparação.
drop function public.dashboard_preview(uuid, jsonb, date, date, jsonb);
create function public.dashboard_preview(p_company uuid, p_spec jsonb, p_from date, p_to date, p_vars jsonb default '{}',
 p_cmp_from date default null, p_cmp_to date default null)
 returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_scope uuid[]; begin
  if mavi_private.leader(p_company) then v_scope := null;
  elsif mavi_private.opt_in_on(p_company, 'dashboards') then v_scope := mavi_private.served_clients(p_company);
  else raise exception 'Sem permissão' using errcode = '42501'; end if;
  perform mavi_private.dashboard_check(p_company,
   jsonb_build_array(jsonb_build_object('id', 'preview', 'title', '', 'x', 0, 'y', 0, 'w', 12, 'h', 4, 'spec', p_spec)),
   coalesce(p_vars, '{}'::jsonb));
  return mavi_private.dashboard_run(p_company, p_spec, p_from, p_to,
   mavi_private.dashboard_scoped(coalesce(p_vars->'filters', '{}'::jsonb), v_scope), p_cmp_from, p_cmp_to)
   || jsonb_build_object('computed_at', now());
end $$;
revoke all on function public.dashboard_preview(uuid, jsonb, date, date, jsonb, date, date) from public, anon;
grant execute on function public.dashboard_preview(uuid, jsonb, date, date, jsonb, date, date) to authenticated;

notify pgrst, 'reload schema';
