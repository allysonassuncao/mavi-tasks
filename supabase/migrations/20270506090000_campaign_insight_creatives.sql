begin;

-- Campanhas › Insights da MAVI: a miniatura dos criativos citados (pedido de
-- 05/10/2026).
--
-- * Quando um insight cita anúncios (o alvo ou os números), o card mostra a
--   miniatura de cada criativo; o clique abre a prévia com o que a MAVI leu
--   nele (Fase 3) e os números daquele anúncio.
-- * Os endereços das imagens das plataformas expiram em dias: o worker gera
--   uma miniatura WebP (até 640 px) UMA vez por criativo e guarda no bucket
--   público, num caminho aleatório (campaign-creatives/<empresa>/<uuid>.webp);
--   campaign_creative_thumbs lembra o endereço pela mesma chave de
--   campaign_creatives (i:<hash> · v:<vídeo> · c:<criativo> · u:<endereço>).
-- * A lista vai em campaign_insights.extra ({creatives: [{entity, name,
--   parent, key, kind, thumb, link, summary, transcript}]}), junto das
--   negativas: o insight reconfirmado numa análise seguinte ganha a lista
--   também (os já abertos recebem a miniatura assim, sem gasto extra).

create table public.campaign_creative_thumbs (
 company_id uuid not null references public.companies(id) on delete cascade,
 platform text not null check (platform in ('meta', 'google')),
 key text not null check (length(key) between 3 and 200),
 url text not null check (url ~ '^https://storage\.googleapis\.com/' and length(url) <= 600),
 created_at timestamptz not null default now(),
 primary key (company_id, platform, key)
);
alter table public.campaign_creative_thumbs enable row level security;
revoke all on public.campaign_creative_thumbs from public, anon, authenticated;

-- As miniaturas já guardadas destes criativos.
create function public.ai_campaign_creative_thumbs_get(p_secret text, p_company uuid, p_platform text, p_keys text[])
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return coalesce((select jsonb_object_agg(t.key, t.url) from public.campaign_creative_thumbs t
  where t.company_id = p_company and t.platform = p_platform
   and t.key = any((coalesce(p_keys, '{}'))[1:200])), '{}');
end $$;

-- Guarda as miniaturas novas ({key: url}).
create function public.ai_campaign_creative_thumbs_put(p_secret text, p_company uuid, p_platform text, p_items jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare k text; u text; v_n integer := 0; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_platform not in ('meta', 'google') or jsonb_typeof(p_items) <> 'object' then return 0; end if;
 for k, u in select e.key, e.value #>> '{}' from jsonb_each(p_items) e
 loop
  continue when length(coalesce(k, '')) not between 3 and 200
   or coalesce(u, '') !~ '^https://storage\.googleapis\.com/' or length(u) > 600;
  insert into public.campaign_creative_thumbs(company_id, platform, key, url)
  values (p_company, p_platform, k, u)
  on conflict (company_id, platform, key) do update set url = excluded.url, created_at = now();
  v_n := v_n + 1;
 end loop;
 return v_n;
end $$;

revoke all on function public.ai_campaign_creative_thumbs_get(text, uuid, text, text[]),
 public.ai_campaign_creative_thumbs_put(text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.ai_campaign_creative_thumbs_get(text, uuid, text, text[]),
 public.ai_campaign_creative_thumbs_put(text, uuid, text, jsonb) to anon, authenticated;

-- A da migração 20270405150000, com os criativos: só o que a tela entende
-- (até 60 negativas e 6 criativos); se passar do tamanho, os criativos vão
-- sem o resumo da leitura.
create or replace function mavi_private.campaign_insight_extra(v jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_neg jsonb; v_cre jsonb; v_out jsonb := '{}'; begin
 if jsonb_typeof(v) <> 'object' then return null; end if;
 if jsonb_typeof(v->'negatives') = 'array' then
  v_neg := coalesce((select jsonb_agg(jsonb_build_object(
    'term', left(btrim(n->>'term'), 200),
    'match', case when n->>'match' = 'phrase' then 'phrase' else 'exact' end,
    'spend', case when n->>'spend' ~ '^[0-9.]+$' then round((n->>'spend')::numeric, 2) else 0 end,
    'clicks', case when n->>'clicks' ~ '^[0-9]+$' then (n->>'clicks')::int else 0 end,
    'campaign', left(coalesce(n->>'campaign', ''), 200),
    'why', left(coalesce(n->>'why', ''), 200)) order by t.k)
   from jsonb_array_elements(v->'negatives') with ordinality t(n, k)
   where jsonb_typeof(n) = 'object' and length(btrim(coalesce(n->>'term', ''))) between 1 and 200 and t.k <= 60), '[]');
  v_out := v_out || jsonb_build_object('negatives', v_neg);
 end if;
 if jsonb_typeof(v->'creatives') = 'array' then
  v_cre := (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'entity', left(c->>'entity', 200),
    'name', left(coalesce(c->>'name', ''), 300),
    'parent', nullif(left(coalesce(c->>'parent', ''), 300), ''),
    'key', left(c->>'key', 200),
    'kind', case when c->>'kind' = 'video' then 'video' else 'image' end,
    'thumb', c->>'thumb',
    'link', case when c->>'link' ~ '^https://(www\.)?(facebook|instagram)\.com/' and length(c->>'link') <= 500
     then c->>'link' end,
    'summary', case when jsonb_typeof(c->'summary') = 'object' then nullif(jsonb_strip_nulls(jsonb_build_object(
      'formato', left(c->'summary'->>'formato', 160), 'promessa', left(c->'summary'->>'promessa', 200),
      'gancho', left(c->'summary'->>'gancho', 200), 'oferta', left(c->'summary'->>'oferta', 160),
      'prova', left(c->'summary'->>'prova', 160), 'cta', left(c->'summary'->>'cta', 120),
      'publico_aparente', left(c->'summary'->>'publico_aparente', 160),
      'texto_na_imagem', left(c->'summary'->>'texto_na_imagem', 200),
      'resumo', left(c->'summary'->>'resumo', 300))), '{}') end,
    'transcript', nullif(left(coalesce(c->>'transcript', ''), 600), ''))) order by t.k)
   from jsonb_array_elements(v->'creatives') with ordinality t(c, k)
   where jsonb_typeof(c) = 'object' and t.k <= 6
    and length(coalesce(c->>'entity', '')) between 1 and 200 and length(coalesce(c->>'key', '')) between 3 and 200
    and coalesce(c->>'thumb', '') ~ '^https://storage\.googleapis\.com/' and length(c->>'thumb') <= 600);
  if v_cre is not null then
   if length((v_out || jsonb_build_object('creatives', v_cre))::text) > 19000 then
    v_cre := (select jsonb_agg(x - 'summary' - 'transcript' order by k) from jsonb_array_elements(v_cre)
     with ordinality t(x, k));
   end if;
   if length((v_out || jsonb_build_object('creatives', v_cre))::text) <= 19500 then
    v_out := v_out || jsonb_build_object('creatives', v_cre);
   end if;
  end if;
 end if;
 return nullif(v_out, '{}');
end $$;

commit;
