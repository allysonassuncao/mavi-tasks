begin;

-- IA do MAVI · fase 3: arquivos do Drive, Social Leads e Campanhas na base
-- de conhecimento.
--
-- - Arquivos do Drive: o banco não lê o storage, então o worker (api/_ai.ts)
--   pega os arquivos pendentes (ai_claim_files), baixa do GCS, extrai o texto
--   (PDF, Word, PowerPoint, Excel, CSV, texto) e devolve por página, slide ou
--   planilha (ai_store_file_text); o banco monta os trechos com esse rótulo
--   para a citação ("Arquivo X, p. 3"). Arquivos sem texto legível (imagem,
--   PDF escaneado) ou de outro tipo entram só pelo nome e pela pasta, para a
--   IA ao menos achá-los. Acesso: a regra do Drive (cliente).
-- - Social Leads: o briefing e cada plano (com os 8 posts e a decisão do
--   cliente). Acesso: quem vê o produto contratado (contract_read).
-- - Campanhas: as anotações e os ciclos (objetivo, meta, verba). Os números
--   vêm ao vivo pela ferramenta ai_campaign_results. Acesso: líderes, como o
--   módulo.

alter table public.ai_documents drop constraint ai_documents_source_type_check;
alter table public.ai_documents add constraint ai_documents_source_type_check
 check (source_type in ('meeting', 'task', 'drive_file', 'social_plan', 'social_briefing', 'campaign'));
alter table public.ai_documents drop constraint ai_documents_access_check;
alter table public.ai_documents add constraint ai_documents_access_check
 check (access in ('client', 'task', 'contract', 'leader'));

-- ------------------------------------------------------------ textos extraídos
create table mavi_private.ai_file_texts (
 file_id uuid primary key,
 company_id uuid not null,
 status text not null check (status in ('pending', 'done', 'empty', 'unsupported', 'too_large', 'error')),
 -- [{label: "Página 3", text: "…"}]
 pages jsonb,
 error text,
 attempts integer not null default 0,
 requested_at timestamptz not null default now(),
 claimed_at timestamptz,
 extracted_at timestamptz
);
create index ai_file_texts_pending on mavi_private.ai_file_texts (requested_at) where status = 'pending';
revoke all on mavi_private.ai_file_texts from public, anon, authenticated;

-- Tipos que o worker sabe ler.
create function mavi_private.ai_file_kind(p_type text, p_name text) returns text
language sql immutable set search_path = '' as $$
 select case
  when lower(p_name) ~ '\.pdf$' or p_type = 'application/pdf' then 'pdf'
  when lower(p_name) ~ '\.docx$' then 'docx'
  when lower(p_name) ~ '\.pptx$' then 'pptx'
  when lower(p_name) ~ '\.xlsx$' then 'xlsx'
  when lower(p_name) ~ '\.(csv|txt|md|json|html?|xml|log)$' or coalesce(p_type, '') like 'text/%' then 'text'
 end
$$;

-- Um objeto JSON (campos de briefing, diagnóstico…) como texto legível.
create function mavi_private.ai_json_text(p jsonb, p_prefix text default '') returns text
language sql immutable set search_path = '' as $$
 select case jsonb_typeof(p)
  when 'object' then (select string_agg(
    case when jsonb_typeof(v) in ('object', 'array') then
      mavi_private.ai_json_text(v, p_prefix || k || ' › ')
     else p_prefix || k || ': ' || (v #>> '{}') end, E'\n' order by k)
   from jsonb_each(p) e(k, v)
   where v is not null and jsonb_typeof(v) <> 'null' and (v #>> '{}') is distinct from '')
  when 'array' then (select string_agg(mavi_private.ai_json_text(v, p_prefix), E'\n')
   from jsonb_array_elements(p) v)
  when 'null' then null
  else case when p_prefix = '' then p #>> '{}' else rtrim(p_prefix, ' ›') || ': ' || (p #>> '{}') end
 end
$$;

-- ------------------------------------------------------------ montagem
create function mavi_private.ai_build_drive_file(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare f record; t mavi_private.ai_file_texts; v_kind text; v_path text; v_header text; v_pieces jsonb := '[]';
 pg jsonb; n integer := 0; piece text; v_status text; v_size text; begin
 select x.*, cl.name as client_name, coalesce(nullif(p.name, ''), k.name) as product_name
  into f from public.drive_files x
  left join public.clients cl on cl.company_id = x.company_id and cl.id = x.client_id
  left join public.contracts k on k.company_id = x.company_id and k.id = x.contract_id
  left join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where x.id = p_id;
 if not found or f.status <> 'ready' then
  perform mavi_private.ai_forget('drive_file', p_id);
  delete from mavi_private.ai_file_texts where file_id = p_id;
  return;
 end if;
 v_kind := mavi_private.ai_file_kind(f.content_type, f.name);
 select * into t from mavi_private.ai_file_texts where file_id = p_id;
 if not found then
  v_status := case when v_kind is null then 'unsupported' when f.size_bytes > 26214400 then 'too_large' else 'pending' end;
  insert into mavi_private.ai_file_texts(file_id, company_id, status) values (p_id, f.company_id, v_status)
  returning * into t;
 end if;
 with recursive chain as (
  select d.id, d.parent_id, d.name, 1 as depth from public.drive_folders d where d.id = f.folder_id
  union all
  select d.id, d.parent_id, d.name, c.depth + 1 from public.drive_folders d join chain c on d.id = c.parent_id
   where c.depth < 20)
 select string_agg(name, ' › ' order by depth desc) into v_path from chain;
 v_header := concat_ws(' · ', format('[Arquivo] "%s"', f.name),
  case when f.client_name is not null then 'cliente ' || f.client_name end,
  case when f.product_name is not null then 'produto ' || f.product_name end,
  case when v_path is not null then 'pasta ' || v_path end,
  'enviado em ' || to_char(f.created_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'));
 if t.status = 'done' and jsonb_typeof(t.pages) = 'array' then
  for pg in select value from jsonb_array_elements(t.pages) loop
   n := n + 1;
   for piece in select mavi_private.ai_split(pg->>'text') loop
    v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text',
     case when pg->>'label' is not null then (pg->>'label') || E'\n' else '' end || piece,
     'meta', jsonb_strip_nulls(jsonb_build_object('kind', 'file', 'page', n, 'label', pg->>'label'))));
   end loop;
  end loop;
 end if;
 if jsonb_array_length(v_pieces) = 0 then
  v_size := case when f.size_bytes >= 1048576 then round(f.size_bytes / 1048576.0, 1) || ' MB'
   else greatest(1, round(f.size_bytes / 1024.0)) || ' KB' end;
  v_pieces := jsonb_build_array(jsonb_build_object('text', format('Arquivo %s (%s, %s). %s', f.name,
    coalesce(v_kind, f.content_type), v_size, case t.status
     when 'pending' then 'O conteúdo ainda está sendo lido.'
     when 'empty' then 'Sem texto legível (imagem ou PDF escaneado).'
     when 'unsupported' then 'O conteúdo deste tipo de arquivo não é lido pela IA.'
     when 'too_large' then 'Grande demais para a IA ler o conteúdo.'
     when 'error' then 'Não foi possível ler o conteúdo.'
     else '' end), 'meta', jsonb_build_object('kind', 'file_name')));
 end if;
 perform mavi_private.ai_save_document(f.company_id, 'drive_file', f.id, 'client', f.client_id, f.contract_id,
  null, null, f.name, f.created_at, v_header, v_pieces);
end $$;

create function mavi_private.ai_build_social_plan(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; v_header text; v_pieces jsonb := '[]'; piece text; p record; begin
 select pl.*, k.client_id, cl.name as client_name, coalesce(nullif(pr.name, ''), k.name) as product_name
  into r from public.social_leads_plans pl
  join public.contracts k on k.company_id = pl.company_id and k.id = pl.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  left join public.products pr on pr.company_id = k.company_id and pr.id = k.product_id
  where pl.id = p_id;
 if not found then perform mavi_private.ai_forget('social_plan', p_id); return; end if;
 v_header := format('[Social Leads] Plano "%s" (mês %s) · cliente %s · produto %s', r.label, r.month_number,
  r.client_name, r.product_name);
 for piece in select mavi_private.ai_split(mavi_private.ai_json_text(r.content)) loop
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', piece, 'meta', jsonb_build_object('kind', 'plan')));
 end loop;
 for p in select * from public.social_leads_posts where plan_id = r.id order by number loop
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', concat_ws(E'\n',
    format('Post %s · %s · %s%s', p.number, p.pillar, p.format, case when p.is_ad then ' · anúncio da campanha' else '' end),
    'Gancho: ' || p.hook, 'Direção da copy: ' || p.copy_direction, 'Direção visual: ' || p.visual_direction,
    'CTA: ' || p.cta,
    'Decisão do cliente: ' || case p.decision when 'approved' then 'aprovado' when 'rejected' then 'reprovado'
     else 'pendente' end || coalesce(nullif(' — ' || p.note, ' — '), '')),
   'meta', jsonb_build_object('kind', 'post', 'post', p.number)));
 end loop;
 perform mavi_private.ai_save_document(r.company_id, 'social_plan', r.id, 'contract', r.client_id, r.contract_id,
  null, null, format('Plano Social Leads · %s', r.label), r.created_at, v_header, v_pieces);
end $$;

-- O briefing é um por produto contratado: o id do documento é o do contrato.
create function mavi_private.ai_build_social_briefing(p_contract uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; v_header text; v_pieces jsonb := '[]'; piece text; begin
 select b.*, k.client_id, cl.name as client_name, coalesce(nullif(pr.name, ''), k.name) as product_name
  into r from public.social_leads_briefings b
  join public.contracts k on k.company_id = b.company_id and k.id = b.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  left join public.products pr on pr.company_id = k.company_id and pr.id = k.product_id
  where b.contract_id = p_contract;
 if not found then perform mavi_private.ai_forget('social_briefing', p_contract); return; end if;
 v_header := format('[Social Leads] Briefing · cliente %s · produto %s', r.client_name, r.product_name);
 for piece in select mavi_private.ai_split(concat_ws(E'\n',
   case when r.campaign_objective is not null then 'Objetivo da campanha: ' ||
    case r.campaign_objective when 'form_nativo' then 'formulário do Meta' else 'conversa no WhatsApp' end end,
   mavi_private.ai_json_text(r.fields))) loop
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', piece, 'meta', jsonb_build_object('kind', 'briefing')));
 end loop;
 perform mavi_private.ai_save_document(r.company_id, 'social_briefing', r.contract_id, 'contract', r.client_id,
  r.contract_id, null, null, 'Briefing Social Leads', r.created_at, v_header, v_pieces);
end $$;

create function mavi_private.ai_build_campaign(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; v_header text; v_body text; v_pieces jsonb := '[]'; piece text; begin
 select c.*, k.client_id, cl.name as client_name, coalesce(nullif(pr.name, ''), k.name) as product_name
  into r from public.ad_campaigns c
  join public.contracts k on k.company_id = c.company_id and k.id = c.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  left join public.products pr on pr.company_id = k.company_id and pr.id = k.product_id
  where c.id = p_id;
 if not found or r.archived then perform mavi_private.ai_forget('campaign', p_id); return; end if;
 v_header := format('[Campanha] "%s" · %s · cliente %s · produto %s', r.name,
  case r.platform when 'meta' then 'Meta' when 'google' then 'Google Ads' else initcap(r.platform) end,
  r.client_name, r.product_name);
 v_body := concat_ws(E'\n\n',
  'Situação: ' || case r.status when 'active' then 'ativa' else 'inativa' end,
  case when btrim(r.notes) <> '' then 'Anotações: ' || r.notes end,
  (select 'Ciclos:' || E'\n' || string_agg(format('- competência %s (%s a %s): objetivo %s, meta de %s resultados, verba R$ %s%s',
     to_char(y.competence_month, 'MM/YYYY'), to_char(y.start_date, 'DD/MM/YYYY'), to_char(y.end_date, 'DD/MM/YYYY'),
     y.objective, y.goal_results, translate(to_char(y.budget, 'FM999,999,990.00'), ',.', '.,'),
     case when y.niche <> '' then ', nicho ' || y.niche else '' end), E'\n' order by y.start_date desc)
   from (select * from public.ad_cycles where company_id = r.company_id and campaign_id = r.id
    order by start_date desc limit 24) y));
 for piece in select mavi_private.ai_split(v_body) loop
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', piece, 'meta', jsonb_build_object('kind', 'campaign')));
 end loop;
 perform mavi_private.ai_save_document(r.company_id, 'campaign', r.id, 'leader', r.client_id, r.contract_id,
  null, null, r.name, r.created_at, v_header, v_pieces);
end $$;

create or replace function mavi_private.ai_build(p_type text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if p_type = 'meeting' then perform mavi_private.ai_build_meeting(p_id);
 elsif p_type = 'task' then perform mavi_private.ai_build_task(p_id);
 elsif p_type = 'drive_file' then perform mavi_private.ai_build_drive_file(p_id);
 elsif p_type = 'social_plan' then perform mavi_private.ai_build_social_plan(p_id);
 elsif p_type = 'social_briefing' then perform mavi_private.ai_build_social_briefing(p_id);
 elsif p_type = 'campaign' then perform mavi_private.ai_build_campaign(p_id);
 end if;
end $$;
revoke all on function mavi_private.ai_file_kind(text, text), mavi_private.ai_json_text(jsonb, text),
 mavi_private.ai_build_drive_file(uuid), mavi_private.ai_build_social_plan(uuid),
 mavi_private.ai_build_social_briefing(uuid), mavi_private.ai_build_campaign(uuid), mavi_private.ai_build(text, uuid)
 from public, anon, authenticated;

-- ------------------------------------------------------------ fila
-- Um gatilho genérico: tg_argv[0] é o tipo do documento e tg_argv[1] a
-- coluna com o id dele.
create function mavi_private.ai_queue_rows() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.ai_enqueue(tg_argv[0], (select jsonb_agg(jsonb_build_object(
  'id', to_jsonb(x) ->> tg_argv[1], 'company_id', x.company_id)) from changed x));
 return null;
end $$;
revoke all on function mavi_private.ai_queue_rows() from public, anon, authenticated;

-- Arquivos: só quando fica pronto, muda de nome ou de lugar, ou sai.
create function mavi_private.ai_queue_drive_update() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.ai_enqueue('drive_file', (select jsonb_agg(jsonb_build_object('id', n.id, 'company_id', n.company_id))
  from new_rows n join old_rows o on o.id = n.id
  where (n.status, n.name, n.client_id, n.contract_id, n.folder_id)
   is distinct from (o.status, o.name, o.client_id, o.contract_id, o.folder_id)));
 return null;
end $$;
revoke all on function mavi_private.ai_queue_drive_update() from public, anon, authenticated;

create trigger ai_queue_drive_ins after insert on public.drive_files
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('drive_file', 'id');
create trigger ai_queue_drive_upd after update on public.drive_files
 referencing old table as old_rows new table as new_rows for each statement execute function mavi_private.ai_queue_drive_update();
create trigger ai_queue_drive_del after delete on public.drive_files
 referencing old table as changed for each statement execute function mavi_private.ai_queue_rows('drive_file', 'id');

create trigger ai_queue_sl_plans_ins after insert on public.social_leads_plans
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('social_plan', 'id');
create trigger ai_queue_sl_plans_upd after update on public.social_leads_plans
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('social_plan', 'id');
create trigger ai_queue_sl_plans_del after delete on public.social_leads_plans
 referencing old table as changed for each statement execute function mavi_private.ai_queue_rows('social_plan', 'id');
create trigger ai_queue_sl_posts_ins after insert on public.social_leads_posts
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('social_plan', 'plan_id');
create trigger ai_queue_sl_posts_upd after update on public.social_leads_posts
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('social_plan', 'plan_id');
create trigger ai_queue_sl_briefings_ins after insert on public.social_leads_briefings
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('social_briefing', 'contract_id');
create trigger ai_queue_sl_briefings_upd after update on public.social_leads_briefings
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('social_briefing', 'contract_id');
create trigger ai_queue_sl_briefings_del after delete on public.social_leads_briefings
 referencing old table as changed for each statement execute function mavi_private.ai_queue_rows('social_briefing', 'contract_id');

create trigger ai_queue_campaigns_ins after insert on public.ad_campaigns
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('campaign', 'id');
create trigger ai_queue_campaigns_upd after update on public.ad_campaigns
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('campaign', 'id');
create trigger ai_queue_campaigns_del after delete on public.ad_campaigns
 referencing old table as changed for each statement execute function mavi_private.ai_queue_rows('campaign', 'id');
create trigger ai_queue_cycles_ins after insert on public.ad_cycles
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('campaign', 'campaign_id');
create trigger ai_queue_cycles_upd after update on public.ad_cycles
 referencing new table as changed for each statement execute function mavi_private.ai_queue_rows('campaign', 'campaign_id');
create trigger ai_queue_cycles_del after delete on public.ad_cycles
 referencing old table as changed for each statement execute function mavi_private.ai_queue_rows('campaign', 'campaign_id');

-- ------------------------------------------------------------ worker: arquivos
-- Os próximos arquivos a ler (reservados por 10 minutos; até 3 tentativas).
create function public.ai_claim_files(p_secret text, p_limit integer default 5)
returns table(file_id uuid, company_id uuid, path text, name text, content_type text, size_bytes bigint, kind text)
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return query
 with picked as (
  update mavi_private.ai_file_texts t set claimed_at = now(), attempts = t.attempts + 1
  where t.file_id in (select x.file_id from mavi_private.ai_file_texts x
   where x.status = 'pending' and x.attempts < 3 and (x.claimed_at is null or x.claimed_at < now() - interval '10 minutes')
   order by x.requested_at limit least(greatest(coalesce(p_limit, 5), 1), 20) for update skip locked)
  returning t.file_id)
 select f.id, f.company_id, f.path, f.name, f.content_type, f.size_bytes, mavi_private.ai_file_kind(f.content_type, f.name)
 from picked p join public.drive_files f on f.id = p.file_id;
end $$;

-- O texto lido (por página/slide/planilha) ou o motivo de não ter texto; o
-- documento é remontado na hora.
create function public.ai_store_file_text(p_secret text, p_file uuid, p_status text, p_pages jsonb, p_error text)
returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_status not in ('done', 'empty', 'unsupported', 'too_large', 'error') then raise exception 'Status inválido'; end if;
 update mavi_private.ai_file_texts set status = case
   when p_status = 'error' and attempts < 3 then 'pending' else p_status end,
  pages = case when p_status = 'done' then p_pages end, error = left(p_error, 500), extracted_at = now(), claimed_at = null
 where file_id = p_file;
 perform mavi_private.ai_build_drive_file(p_file);
end $$;
revoke all on function public.ai_claim_files(text, integer), public.ai_store_file_text(text, uuid, text, jsonb, text)
 from public, anon, authenticated;
grant execute on function public.ai_claim_files(text, integer), public.ai_store_file_text(text, uuid, text, jsonb, text)
 to anon, authenticated;

create or replace function mavi_private.ai_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.ai_queue where attempts < 5)
  and not exists (select 1 from public.ai_chunks where embedding is null)
  and not exists (select 1 from mavi_private.ai_file_texts where status = 'pending' and attempts < 3) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-index"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

create or replace function public.ai_index_status(p_secret text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object(
  'queue', (select count(*) from mavi_private.ai_queue where attempts < 5),
  'failed', (select count(*) from mavi_private.ai_queue where attempts >= 5),
  'pending', (select count(*) from public.ai_chunks where embedding is null),
  'files_pending', (select count(*) from mavi_private.ai_file_texts where status = 'pending' and attempts < 3),
  'chunks', (select count(*) from public.ai_chunks),
  'documents', (select count(*) from public.ai_documents));
end $$;

-- ------------------------------------------------------------ permissões
-- Produtos contratados que a pessoa vê (as regras do contract_read).
create function mavi_private.ai_visible_contracts(c uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(k.id), '{}') from public.contracts k
 where k.company_id = c and mavi_private.contract_read(c, k.id)
$$;
-- O mesmo para outra pessoa (compartilhar uma conversa).
create function mavi_private.ai_user_sees_contract(c uuid, u uuid, k uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.memberships m where m.company_id = c and m.user_id = u and m.active and (
  m.role = 'admin'
  or exists (select 1 from public.contracts kk
   join public.client_teams ct on ct.company_id = kk.company_id and ct.client_id = kk.client_id
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
   where kk.company_id = c and kk.id = k and tm.user_id = u)
  or exists (select 1 from public.tasks t where t.company_id = c and t.contract_id = k
   and mavi_private.ai_user_sees_task(c, u, t.id))))
$$;
create function mavi_private.ai_user_is_leader(c uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (select 1 from public.memberships m where m.company_id = c and m.user_id = u and m.active
  and m.role in ('admin', 'manager'))
$$;
revoke all on function mavi_private.ai_visible_contracts(uuid), mavi_private.ai_user_sees_contract(uuid, uuid, uuid),
 mavi_private.ai_user_is_leader(uuid, uuid) from public, anon, authenticated;

create or replace function public.ai_search(p_company uuid, p_embedding text, p_query text, p_filters jsonb default '{}',
 p_limit integer default 12)
returns table(chunk_id bigint, document_id uuid, source_type text, source_id uuid, title text, content text,
 meta jsonb, client_id uuid, contract_id uuid, project_id uuid, occurred_at timestamptz, score double precision,
 task_status text, task_assignee uuid, task_due date)
language plpgsql volatile security definer set search_path = '' as $$
declare
 v_leader boolean; v_clients uuid[]; v_tasks uuid[]; v_contracts uuid[]; v_vec extensions.halfvec(1536); v_tq tsquery;
 f_client uuid; f_contract uuid; f_project uuid; f_task uuid; f_types text[]; f_from timestamptz; f_to timestamptz;
 v_k integer; v_limit integer;
begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 v_leader := mavi_private.leader(p_company);
 if not v_leader then
  v_clients := mavi_private.ai_visible_clients(p_company);
  v_tasks := mavi_private.ai_visible_tasks(p_company);
 end if;
 -- Social Leads segue o contract_read (gestores fora das equipes não veem).
 v_contracts := mavi_private.ai_visible_contracts(p_company);
 f_client := nullif(p_filters->>'client', '')::uuid;
 f_contract := nullif(p_filters->>'contract', '')::uuid;
 f_project := nullif(p_filters->>'project', '')::uuid;
 f_task := nullif(p_filters->>'task', '')::uuid;
 f_types := case when jsonb_typeof(p_filters->'types') = 'array'
  then array(select jsonb_array_elements_text(p_filters->'types')) end;
 f_from := nullif(p_filters->>'from', '')::timestamptz;
 f_to := nullif(p_filters->>'to', '')::timestamptz;
 v_limit := least(greatest(coalesce(p_limit, 12), 1), 40);
 v_k := greatest(v_limit * 4, 40);
 if nullif(p_embedding, '') is not null then v_vec := p_embedding::extensions.halfvec(1536); end if;
 v_tq := nullif(replace(plainto_tsquery('portuguese'::regconfig, left(coalesce(p_query, ''), 500))::text, ' & ', ' | '), '')::tsquery;
 begin
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  perform set_config('hnsw.ef_search', '100', true);
 exception when others then null;
 end;
 -- O filtro se repete nas duas buscas de propósito: um CTE compartilhado
 -- seria materializado e o índice vetorial deixaria de ser usado.
 return query
 with vec as (
  select s.id, row_number() over () as rn from (
   select c.id from public.ai_chunks c
   where v_vec is not null and c.embedding is not null and c.company_id = p_company
    and (f_client is null or c.client_id = f_client)
    and (f_contract is null or c.contract_id = f_contract)
    and (f_project is null or c.project_id = f_project)
    and (f_task is null or c.task_id = f_task)
    and (f_types is null or c.source_type = any(f_types))
    and (f_from is null or c.occurred_at >= f_from)
    and (f_to is null or c.occurred_at < f_to + interval '1 day')
    and ((c.access = 'client' and (v_leader or c.client_id is null or c.client_id = any(v_clients)))
     or (c.access = 'task' and (v_leader or c.task_id = any(v_tasks)))
     or (c.access = 'contract' and c.contract_id = any(v_contracts))
     or (c.access = 'leader' and v_leader))
   order by c.embedding operator(extensions.<=>) v_vec limit v_k) s
 ),
 txt as (
  select s.id, row_number() over () as rn from (
   select c.id from public.ai_chunks c
   where v_tq is not null and c.search @@ v_tq and c.company_id = p_company
    and (f_client is null or c.client_id = f_client)
    and (f_contract is null or c.contract_id = f_contract)
    and (f_project is null or c.project_id = f_project)
    and (f_task is null or c.task_id = f_task)
    and (f_types is null or c.source_type = any(f_types))
    and (f_from is null or c.occurred_at >= f_from)
    and (f_to is null or c.occurred_at < f_to + interval '1 day')
    and ((c.access = 'client' and (v_leader or c.client_id is null or c.client_id = any(v_clients)))
     or (c.access = 'task' and (v_leader or c.task_id = any(v_tasks)))
     or (c.access = 'contract' and c.contract_id = any(v_contracts))
     or (c.access = 'leader' and v_leader))
   order by ts_rank_cd(c.search, v_tq) desc limit v_k) s
 ),
 fused as (
  select u.id, sum(1.0 / (60 + u.rn)) as score from (select * from vec union all select * from txt) u
  group by u.id order by score desc limit v_limit
 )
 select c.id, c.document_id, c.source_type, d.source_id, d.title, c.content, c.meta, c.client_id, c.contract_id,
  c.project_id, c.occurred_at, f.score::double precision, t.status, t.assignee_id, t.due_date
 from fused f
 join public.ai_chunks c on c.id = f.id
 join public.ai_documents d on d.id = c.document_id
 left join public.tasks t on t.company_id = c.company_id and t.id = c.task_id
 order by f.score desc;
end $$;

create or replace function public.ai_read(p_chunk bigint, p_window integer default 2)
returns table(chunk_id bigint, document_id uuid, ord integer, content text, meta jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare c public.ai_chunks; v_ok boolean; begin
 select * into c from public.ai_chunks x where x.id = p_chunk;
 if not found then return; end if;
 v_ok := mavi_private.member(c.company_id) and case c.access
  when 'client' then mavi_private.leader(c.company_id) or mavi_private.drive_can_read(c.company_id, c.client_id)
  when 'task' then mavi_private.leader(c.company_id) or mavi_private.task_access(c.company_id, c.task_id)
  when 'contract' then mavi_private.contract_read(c.company_id, c.contract_id)
  when 'leader' then mavi_private.leader(c.company_id)
  else false end;
 if not v_ok then raise exception 'Sem acesso' using errcode = '42501'; end if;
 return query select x.id, x.document_id, x.ord, x.content, x.meta from public.ai_chunks x
  where x.document_id = c.document_id and x.ord between c.ord - least(greatest(p_window, 0), 5)
   and c.ord + least(greatest(p_window, 0), 5)
  order by x.ord;
end $$;

-- Compartilhar: cada tipo de fonte com a sua regra.
create or replace function public.ai_share_conversation(p_conversation uuid, p_users uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.ai_conversations; u uuid; s jsonb; refused jsonb := '[]'; shared uuid[] := '{}'; ok boolean; v_name text; begin
 select * into v from public.ai_conversations where id = p_conversation;
 if not found or v.owner_id <> auth.uid() or not mavi_private.member(v.company_id) then
  raise exception 'Só quem começou a conversa compartilha.' using errcode = '42501';
 end if;
 for u in select distinct x from unnest(coalesce(p_users, '{}')) x where x <> v.owner_id loop
  ok := exists (select 1 from public.memberships m where m.company_id = v.company_id and m.user_id = u and m.active);
  if ok then
   for s in select jsonb_array_elements(m.sources) from public.ai_messages m where m.conversation_id = v.id loop
    ok := case s->>'type'
      when 'task' then mavi_private.ai_user_sees_task(v.company_id, u, (s->>'id')::uuid)
      when 'social' then mavi_private.ai_user_sees_contract(v.company_id, u, nullif(s->>'contract_id', '')::uuid)
      when 'campaign' then mavi_private.ai_user_is_leader(v.company_id, u)
      else mavi_private.ai_user_sees_client(v.company_id, u, nullif(s->>'client_id', '')::uuid) end;
    exit when not ok;
   end loop;
   if not ok then
    refused := refused || jsonb_build_object('user', u, 'reason', 'não tem acesso a alguma fonte citada');
   else
    shared := shared || u;
   end if;
  else
   refused := refused || jsonb_build_object('user', u, 'reason', 'não está ativo na empresa');
  end if;
 end loop;
 delete from public.ai_conversation_shares where conversation_id = v.id and not (user_id = any(shared));
 select name into v_name from public.memberships where company_id = v.company_id and user_id = auth.uid();
 with added as (
  insert into public.ai_conversation_shares(company_id, conversation_id, user_id)
  select v.company_id, v.id, x from unnest(shared) x
  on conflict do nothing
  returning user_id)
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 select v.company_id, a.user_id, auth.uid(), null, 'ai_share',
  format('%s compartilhou uma conversa da IA', coalesce(v_name, 'Alguém')), v.title,
  '/visao-geral?conversa=' || v.id
 from added a;
 return jsonb_build_object('shared', to_jsonb(shared), 'refused', refused);
end $$;

-- ------------------------------------------------------------ números das campanhas
-- Resultados no período (RLS: só líderes veem campanhas): cada campanha com
-- os ciclos que tocam o período e as somas dos dias dentro dele.
create function public.ai_campaign_results(p_company uuid, p_client uuid, p_from date, p_to date)
returns jsonb
language sql stable set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
   'campaign', c.id, 'name', c.name, 'platform', c.platform, 'status', c.status, 'client', k.client_id,
   'cycles', (select coalesce(jsonb_agg(jsonb_build_object(
      'start', y.start_date, 'end', y.end_date, 'objective', y.objective, 'goal_results', y.goal_results,
      'budget', y.budget, 'spend', coalesce(m.spend, 0), 'impressions', coalesce(m.impressions, 0),
      'clicks', coalesce(m.clicks, 0), 'results', coalesce(m.conversions, 0)) order by y.start_date desc), '[]')
    from public.ad_cycles y
    left join lateral (select sum(d.spend) spend, sum(d.impressions) impressions, sum(d.clicks) clicks,
      sum(d.conversions) conversions from public.ad_daily_metrics d
     where d.company_id = y.company_id and d.cycle_id = y.id and d.day between p_from and p_to) m on true
    where y.company_id = c.company_id and y.campaign_id = c.id and y.start_date <= p_to and y.end_date >= p_from))
  order by c.name), '[]')
 from public.ad_campaigns c
 join public.contracts k on k.company_id = c.company_id and k.id = c.contract_id
 where c.company_id = p_company and not c.archived and (p_client is null or k.client_id = p_client)
$$;
revoke all on function public.ai_campaign_results(uuid, uuid, date, date) from public, anon;
grant execute on function public.ai_campaign_results(uuid, uuid, date, date) to authenticated;

-- O que já existe entra na fila (o worker indexa aos poucos).
insert into mavi_private.ai_queue(source_type, source_id, company_id)
select 'drive_file', id, company_id from public.drive_files where status = 'ready'
union all select 'social_plan', id, company_id from public.social_leads_plans
union all select 'social_briefing', contract_id, company_id from public.social_leads_briefings
union all select 'campaign', id, company_id from public.ad_campaigns where not archived
on conflict do nothing;

commit;
