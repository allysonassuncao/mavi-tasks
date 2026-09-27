begin;

-- Cases de Sucesso: a biblioteca de provas sociais da agência. Qualquer
-- pessoa cadastra o case de um cliente (título, resumo, números em destaque,
-- nichos, produtos da Make, mídias, links e textos como telefone e e-mail);
-- ele só aparece para todos depois que um administrador ou gestor aprova.
--
-- - Case novo: fica "em análise" (só o autor e os líderes veem). Aprovado,
--   entra na biblioteca; devolvido, volta ao autor com o motivo. Cases de
--   líderes já nascem aprovados (são eles que aprovam).
-- - Edição do autor num case aprovado vira um rascunho
--   (success_case_drafts) e passa por aprovação de novo; a versão aprovada
--   continua na biblioteca até lá. Mídias novas do rascunho ficam marcadas
--   (pending) e as removidas só saem quando ele for aprovado. Edição de
--   líder vale na hora.
-- - Mídias no GCS (bucket do Drive, privado): o navegador nunca vê o
--   caminho, só links assinados (api/_cases.ts). As funções que apagam
--   devolvem os caminhos para o servidor remover os objetos.
-- - Link público (/cases/<token>) para mandar ao lead: só de case aprovado,
--   escolhendo se mostra o nome do cliente e os contatos.
-- - Cases aprovados entram no cérebro da MAVI (source_type success_case),
--   visíveis para todos da empresa (access 'client' sem cliente).
-- - Tudo passa por funções: as tabelas não têm leitura direta, porque quem
--   não atende o cliente também vê o case (e o nome do cliente).

-- ------------------------------------------------------------ tabelas
create table public.success_cases (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 client_id uuid not null,
 title text not null check (length(btrim(title)) between 3 and 160),
 summary text not null default '' check (length(summary) <= 5000),
 -- [{value: "+320", label: "leads por mês"}], até 4.
 highlights jsonb not null default '[]' check (jsonb_typeof(highlights) = 'array'),
 niches text[] not null default '{}',
 product_ids uuid[] not null default '{}',
 -- [{url, label}]
 links jsonb not null default '[]' check (jsonb_typeof(links) = 'array'),
 -- [{label: "WhatsApp", value: "(11) 99999-0000"}]
 contacts jsonb not null default '[]' check (jsonb_typeof(contacts) = 'array'),
 status text not null default 'pending' check (status in ('pending', 'approved', 'returned')),
 review_note text check (length(review_note) <= 1000),
 created_by uuid not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 submitted_at timestamptz not null default now(),
 reviewed_by uuid,
 reviewed_at timestamptz,
 approved_at timestamptz,
 share_enabled boolean not null default false,
 share_token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
 share_client boolean not null default true,
 share_contacts boolean not null default false,
 share_views integer not null default 0,
 -- Texto da busca, sem acentos (título, resumo, nichos, números, links,
 -- contatos, produtos); o nome do cliente entra na hora da busca.
 search text not null default '',
 version integer not null default 1,
 unique(company_id, id),
 foreign key(company_id, client_id) references public.clients(company_id, id),
 foreign key(company_id, created_by) references public.memberships(company_id, user_id)
);
create index success_cases_list on public.success_cases(company_id, status, approved_at desc);
create index success_cases_client on public.success_cases(company_id, client_id);
create index success_cases_author on public.success_cases(company_id, created_by);
create index success_cases_search on public.success_cases using gin(search gin_trgm_ops);
alter table public.success_cases enable row level security;
revoke all on public.success_cases from public, anon, authenticated;

create table public.success_case_drafts (
 case_id uuid primary key,
 company_id uuid not null,
 -- {client_id, title, summary, highlights, niches, product_ids, links, contacts}
 content jsonb not null check (jsonb_typeof(content) = 'object'),
 removed_media uuid[] not null default '{}',
 status text not null default 'pending' check (status in ('pending', 'returned')),
 review_note text check (length(review_note) <= 1000),
 submitted_by uuid not null,
 submitted_at timestamptz not null default now(),
 foreign key(company_id, case_id) references public.success_cases(company_id, id) on delete cascade
);
create index success_case_drafts_pending on public.success_case_drafts(company_id) where status = 'pending';
alter table public.success_case_drafts enable row level security;
revoke all on public.success_case_drafts from public, anon, authenticated;

create table public.success_case_media (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 case_id uuid not null,
 name text not null check (length(btrim(name)) between 1 and 255),
 content_type text not null check (length(content_type) between 3 and 200),
 size_bytes bigint not null check (size_bytes between 1 and 524288000),
 path text not null unique,
 status text not null default 'uploading' check (status in ('uploading', 'ready')),
 -- Enviada numa edição que ainda espera aprovação.
 pending boolean not null default false,
 position integer not null default 0,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 unique(company_id, id),
 foreign key(company_id, case_id) references public.success_cases(company_id, id) on delete cascade
);
create index success_case_media_case on public.success_case_media(company_id, case_id, position);
alter table public.success_case_media enable row level security;
revoke all on public.success_case_media from public, anon, authenticated;

-- ------------------------------------------------------------ regras
create function mavi_private.case_can_see(s public.success_cases) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(s.company_id)
  and (s.status = 'approved' or s.created_by = auth.uid() or mavi_private.leader(s.company_id))
$$;
create function mavi_private.case_can_edit(s public.success_cases) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(s.company_id) and (s.created_by = auth.uid() or mavi_private.leader(s.company_id))
$$;
revoke all on function mavi_private.case_can_see(public.success_cases), mavi_private.case_can_edit(public.success_cases)
 from public, anon, authenticated;

-- O conteúdo que a pessoa enviou, limpo e conferido. Nichos iguais sem
-- acento/maiúscula viram a grafia que já existe (nos cases e nas campanhas).
create function mavi_private.case_clean(c uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid; v_title text; v_summary text; x jsonb; v text; l text; k text; canon text;
 v_high jsonb := '[]'; v_links jsonb := '[]'; v_contacts jsonb := '[]'; v_niches text[] := '{}'; seen text[] := '{}';
 v_products uuid[]; begin
 if jsonb_typeof(p) <> 'object' then raise exception 'Conteúdo inválido' using errcode = '22023'; end if;
 begin
  v_client := nullif(p->>'client_id', '')::uuid;
 exception when others then v_client := null;
 end;
 if v_client is null or not exists (select 1 from public.clients where company_id = c and id = v_client) then
  raise exception 'Escolha o cliente do case.' using errcode = '22023';
 end if;
 v_title := regexp_replace(btrim(coalesce(p->>'title', '')), '\s+', ' ', 'g');
 if length(v_title) < 3 or length(v_title) > 160 then
  raise exception 'Dê um título de 3 a 160 caracteres ao case.' using errcode = '22023';
 end if;
 v_summary := btrim(coalesce(p->>'summary', ''));
 if length(v_summary) > 5000 then raise exception 'O resumo pode ter até 5.000 caracteres.' using errcode = '22023'; end if;

 for x in select value from jsonb_array_elements(case when jsonb_typeof(p->'highlights') = 'array' then p->'highlights' else '[]' end) loop
  v := btrim(coalesce(x->>'value', '')); l := btrim(coalesce(x->>'label', ''));
  continue when v = '' and l = '';
  if v = '' then raise exception 'Todo resultado em destaque precisa de um número ou valor.' using errcode = '22023'; end if;
  if length(v) > 24 or length(l) > 80 then
   raise exception 'Resultado em destaque: até 24 caracteres no número e 80 na descrição.' using errcode = '22023';
  end if;
  v_high := v_high || jsonb_build_array(jsonb_build_object('value', v, 'label', l));
 end loop;
 if jsonb_array_length(v_high) > 4 then raise exception 'Escolha até 4 resultados em destaque.' using errcode = '22023'; end if;

 for v in select jsonb_array_elements_text(case when jsonb_typeof(p->'niches') = 'array' then p->'niches' else '[]' end) loop
  v := regexp_replace(btrim(v), '\s+', ' ', 'g');
  continue when v = '';
  if length(v) > 60 then raise exception 'Cada nicho pode ter até 60 caracteres.' using errcode = '22023'; end if;
  k := mavi_private.fold(v);
  continue when k = any(seen);
  seen := seen || k;
  select z.x into canon from (
   select unnest(s.niches) as x from public.success_cases s where s.company_id = c
   union all
   select y.niche from public.ad_cycles y where y.company_id = c and y.niche <> '') z
  where mavi_private.fold(z.x) = k group by z.x order by count(*) desc, z.x limit 1;
  v_niches := v_niches || coalesce(canon, v);
 end loop;
 if cardinality(v_niches) > 10 then raise exception 'Escolha até 10 nichos.' using errcode = '22023'; end if;

 select coalesce(array_agg(pr.id order by pr.name), '{}') into v_products from public.products pr
 where pr.company_id = c and pr.id::text in (
  select jsonb_array_elements_text(case when jsonb_typeof(p->'product_ids') = 'array' then p->'product_ids' else '[]' end));

 for x in select value from jsonb_array_elements(case when jsonb_typeof(p->'links') = 'array' then p->'links' else '[]' end) loop
  v := btrim(coalesce(x->>'url', '')); l := btrim(coalesce(x->>'label', ''));
  continue when v = '';
  if v !~* '^https?://[^\s<>"]+$' or length(v) > 1000 then
   raise exception 'Link inválido: %', left(v, 80) using errcode = '22023';
  end if;
  if length(l) > 80 then raise exception 'O nome de um link pode ter até 80 caracteres.' using errcode = '22023'; end if;
  v_links := v_links || jsonb_build_array(jsonb_build_object('url', v, 'label', l));
 end loop;
 if jsonb_array_length(v_links) > 30 then raise exception 'Adicione até 30 links.' using errcode = '22023'; end if;

 for x in select value from jsonb_array_elements(case when jsonb_typeof(p->'contacts') = 'array' then p->'contacts' else '[]' end) loop
  v := btrim(coalesce(x->>'value', '')); l := btrim(coalesce(x->>'label', ''));
  continue when v = '';
  if length(v) > 500 or length(l) > 40 then
   raise exception 'Textos: até 40 caracteres no nome e 500 no conteúdo.' using errcode = '22023';
  end if;
  v_contacts := v_contacts || jsonb_build_array(jsonb_build_object('label', l, 'value', v));
 end loop;
 if jsonb_array_length(v_contacts) > 20 then raise exception 'Adicione até 20 textos.' using errcode = '22023'; end if;

 return jsonb_build_object('client_id', v_client, 'title', v_title, 'summary', v_summary, 'highlights', v_high,
  'niches', to_jsonb(v_niches), 'product_ids', to_jsonb(v_products), 'links', v_links, 'contacts', v_contacts);
end $$;
revoke all on function mavi_private.case_clean(uuid, jsonb) from public, anon, authenticated;

-- O texto da busca (sem acentos).
create function mavi_private.case_search_text() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 new.search := mavi_private.fold(concat_ws(' ', new.title, new.summary, array_to_string(new.niches, ' '),
  (select string_agg(concat_ws(' ', h->>'value', h->>'label'), ' ') from jsonb_array_elements(new.highlights) h),
  (select string_agg(concat_ws(' ', x->>'label', x->>'url'), ' ') from jsonb_array_elements(new.links) x),
  (select string_agg(concat_ws(' ', x->>'label', x->>'value'), ' ') from jsonb_array_elements(new.contacts) x),
  (select string_agg(pr.name, ' ') from public.products pr where pr.company_id = new.company_id and pr.id = any(new.product_ids))));
 return new;
end $$;
revoke all on function mavi_private.case_search_text() from public, anon, authenticated;
create trigger success_case_search before insert or update of title, summary, niches, highlights, links, contacts, product_ids
 on public.success_cases for each row execute function mavi_private.case_search_text();

-- ------------------------------------------------------------ avisos
create function mavi_private.case_notify(c uuid, p_users uuid[], p_title text, p_body text, p_case uuid) returns void
language sql security definer set search_path = '' as $$
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 select c, u, auth.uid(), null, 'success_case', left(p_title, 300), left(p_body, 300),
  '/cases-de-sucesso?caso=' || p_case
 from (select distinct x as u from unnest(coalesce(p_users, '{}')) x) q
 where u is distinct from auth.uid()
  and exists (select 1 from public.memberships m where m.company_id = c and m.user_id = q.u and m.active)
$$;
-- Quem aprova: administradores e gestores ativos.
create function mavi_private.case_reviewers(c uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(user_id), '{}') from public.memberships
 where company_id = c and active and role in ('admin', 'manager')
$$;
create function mavi_private.member_name(c uuid, u uuid) returns text
language sql stable security definer set search_path = '' as $$
 select coalesce((select name from public.memberships where company_id = c and user_id = u), 'Alguém')
$$;
revoke all on function mavi_private.case_notify(uuid, uuid[], text, text, uuid), mavi_private.case_reviewers(uuid),
 mavi_private.member_name(uuid, uuid) from public, anon, authenticated;

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null)));

-- ------------------------------------------------------------ salvar
-- Cria ou salva um case. Devolve {id, mode}: 'created' (novo), 'saved'
-- (valeu na hora) ou 'draft' (edição do autor num case aprovado, que espera
-- aprovação).
create function public.save_success_case(p_company uuid, p_case uuid, p_content jsonb, p_version integer default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.success_cases; v jsonb; v_leader boolean; v_name text; v_client text; had_draft boolean;
 v_resubmit boolean; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v := mavi_private.case_clean(p_company, p_content);
 v_leader := mavi_private.leader(p_company);
 v_name := mavi_private.member_name(p_company, auth.uid());
 select name into v_client from public.clients where company_id = p_company and id = (v->>'client_id')::uuid;

 if p_case is null then
  insert into public.success_cases(company_id, client_id, title, summary, highlights, niches, product_ids, links, contacts,
   status, created_by, reviewed_by, reviewed_at, approved_at)
  values (p_company, (v->>'client_id')::uuid, v->>'title', v->>'summary', v->'highlights',
   array(select jsonb_array_elements_text(v->'niches')), array(select jsonb_array_elements_text(v->'product_ids'))::uuid[],
   v->'links', v->'contacts',
   case when v_leader then 'approved' else 'pending' end, auth.uid(),
   case when v_leader then auth.uid() end, case when v_leader then now() end, case when v_leader then now() end)
  returning * into s;
  if not v_leader then
   perform mavi_private.case_notify(p_company, mavi_private.case_reviewers(p_company),
    format('Novo case para aprovar: %s', s.title), format('%s cadastrou um case de %s.', v_name, v_client), s.id);
  end if;
  return jsonb_build_object('id', s.id, 'mode', 'created', 'status', s.status);
 end if;

 select * into s from public.success_cases where id = p_case and company_id = p_company for update;
 if not found or not mavi_private.case_can_edit(s) then
  raise exception 'Só quem cadastrou o case ou um administrador/gestor pode editá-lo.' using errcode = '42501';
 end if;
 if p_version is not null and p_version <> s.version then
  raise exception 'Este case foi alterado por outra pessoa. Abra de novo para ver a versão atual.' using errcode = '40001';
 end if;

 if v_leader or s.status <> 'approved' then
  -- O autor corrigindo um case devolvido manda de novo para aprovação.
  v_resubmit := not v_leader and s.status = 'returned';
  update public.success_cases set client_id = (v->>'client_id')::uuid, title = v->>'title', summary = v->>'summary',
   highlights = v->'highlights', niches = array(select jsonb_array_elements_text(v->'niches')),
   product_ids = array(select jsonb_array_elements_text(v->'product_ids'))::uuid[], links = v->'links',
   contacts = v->'contacts', updated_at = now(), version = version + 1,
   status = case when v_resubmit then 'pending' else status end,
   submitted_at = case when v_resubmit then now() else submitted_at end,
   review_note = case when v_resubmit then null else review_note end
  where id = s.id returning * into s;
  if v_resubmit then
   perform mavi_private.case_notify(p_company, mavi_private.case_reviewers(p_company),
    format('Case corrigido para aprovar: %s', s.title), format('%s corrigiu o case de %s.', v_name, v_client), s.id);
  end if;
  return jsonb_build_object('id', s.id, 'mode', 'saved', 'status', s.status);
 end if;

 -- Autor editando um case aprovado: rascunho para aprovar.
 select status = 'pending' into had_draft from public.success_case_drafts where case_id = s.id;
 insert into public.success_case_drafts(case_id, company_id, content, submitted_by)
 values (s.id, p_company, v, auth.uid())
 on conflict (case_id) do update set content = excluded.content, status = 'pending', review_note = null,
  submitted_by = excluded.submitted_by, submitted_at = now();
 if not coalesce(had_draft, false) then
  perform mavi_private.case_notify(p_company, mavi_private.case_reviewers(p_company),
   format('Alteração de case para aprovar: %s', s.title), format('%s editou o case de %s.', v_name, v_client), s.id);
 end if;
 return jsonb_build_object('id', s.id, 'mode', 'draft', 'status', s.status);
end $$;

-- ------------------------------------------------------------ aprovar
-- Aprova ou devolve (com motivo) um case em análise ou a alteração que
-- espera aprovação. Devolve os caminhos das mídias que saíram.
create function public.review_success_case(p_case uuid, p_approve boolean, p_note text default null)
returns text[]
language plpgsql security definer set search_path = '' as $$
declare s public.success_cases; d public.success_case_drafts; v jsonb; paths text[] := '{}'; v_note text; begin
 select * into s from public.success_cases where id = p_case for update;
 if not found or not mavi_private.leader(s.company_id) then
  raise exception 'Só administradores e gestores aprovam cases.' using errcode = '42501';
 end if;
 v_note := nullif(btrim(coalesce(p_note, '')), '');
 if not p_approve and v_note is null then
  raise exception 'Diga o que precisa mudar para devolver o case.' using errcode = '22023';
 end if;
 select * into d from public.success_case_drafts where case_id = s.id for update;

 if d.case_id is not null and d.status = 'pending' then
  if p_approve then
   -- O conteúdo pode depender de algo que mudou (produto apagado…).
   v := mavi_private.case_clean(s.company_id, d.content);
   with gone as (
    delete from public.success_case_media where company_id = s.company_id and case_id = s.id and id = any(d.removed_media)
    returning path)
   select coalesce(array_agg(path), '{}') into paths from gone;
   update public.success_case_media set pending = false where company_id = s.company_id and case_id = s.id and pending;
   update public.success_cases set client_id = (v->>'client_id')::uuid, title = v->>'title', summary = v->>'summary',
    highlights = v->'highlights', niches = array(select jsonb_array_elements_text(v->'niches')),
    product_ids = array(select jsonb_array_elements_text(v->'product_ids'))::uuid[], links = v->'links',
    contacts = v->'contacts', updated_at = now(), version = version + 1, reviewed_by = auth.uid(), reviewed_at = now()
   where id = s.id returning * into s;
   delete from public.success_case_drafts where case_id = s.id;
   perform mavi_private.case_notify(s.company_id, array[d.submitted_by], format('Alteração aprovada: %s', s.title),
    format('%s aprovou a sua edição do case.', mavi_private.member_name(s.company_id, auth.uid())), s.id);
  else
   update public.success_case_drafts set status = 'returned', review_note = v_note where case_id = s.id;
   perform mavi_private.case_notify(s.company_id, array[d.submitted_by], format('Alteração devolvida: %s', s.title),
    v_note, s.id);
  end if;
  return paths;
 end if;

 if s.status <> 'pending' then raise exception 'Este case não está esperando aprovação.' using errcode = '22023'; end if;
 if p_approve then
  update public.success_cases set status = 'approved', approved_at = now(), reviewed_by = auth.uid(), reviewed_at = now(),
   review_note = null
  where id = s.id;
  perform mavi_private.case_notify(s.company_id, array[s.created_by], format('Case aprovado: %s', s.title),
   format('%s aprovou o case. Ele já aparece para todos.', mavi_private.member_name(s.company_id, auth.uid())), s.id);
 else
  update public.success_cases set status = 'returned', review_note = v_note, reviewed_by = auth.uid(), reviewed_at = now()
  where id = s.id;
  perform mavi_private.case_notify(s.company_id, array[s.created_by], format('Case devolvido: %s', s.title), v_note, s.id);
 end if;
 return paths;
end $$;

-- Desiste da alteração que espera aprovação: as mídias novas dela saem.
create function public.discard_success_case_draft(p_case uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare s public.success_cases; paths text[]; begin
 select * into s from public.success_cases where id = p_case for update;
 if not found or not mavi_private.case_can_edit(s) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from public.success_case_drafts where case_id = s.id;
 with gone as (
  delete from public.success_case_media where company_id = s.company_id and case_id = s.id and pending returning path)
 select coalesce(array_agg(path), '{}') into paths from gone;
 return paths;
end $$;

-- Apaga o case (o autor enquanto não foi aprovado; líderes sempre).
create function public.delete_success_case(p_case uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare s public.success_cases; paths text[]; begin
 select * into s from public.success_cases where id = p_case for update;
 if not found or not (mavi_private.leader(s.company_id)
  or (s.created_by = auth.uid() and s.status <> 'approved' and mavi_private.member(s.company_id))) then
  raise exception 'Só administradores e gestores apagam um case aprovado.' using errcode = '42501';
 end if;
 select coalesce(array_agg(path), '{}') into paths from public.success_case_media where company_id = s.company_id and case_id = s.id;
 delete from public.success_cases where id = s.id;
 return paths;
end $$;

-- ------------------------------------------------------------ mídias
create function public.prepare_success_case_media(p_case uuid, p_name text, p_size bigint, p_content_type text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.success_cases; v_id uuid := gen_random_uuid(); v_pending boolean; v_type text; begin
 select * into s from public.success_cases where id = p_case;
 if not found or not mavi_private.case_can_edit(s) then raise exception 'Sem permissão para enviar mídias a este case.' using errcode = '42501'; end if;
 if p_size is null or p_size < 1 or p_size > 524288000 then raise exception 'Envie arquivos de até 500 MB.' using errcode = '22023'; end if;
 if length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'Arquivo sem nome' using errcode = '22023'; end if;
 v_pending := s.status = 'approved' and not mavi_private.leader(s.company_id);
 if v_pending and not exists (select 1 from public.success_case_drafts where case_id = s.id) then
  raise exception 'Salve a edição antes de enviar mídias.' using errcode = '22023';
 end if;
 if (select count(*) from public.success_case_media where company_id = s.company_id and case_id = s.id) >= 80 then
  raise exception 'Um case pode ter até 80 mídias.' using errcode = '22023';
 end if;
 v_type := lower(coalesce(nullif(btrim(p_content_type), ''), 'application/octet-stream'));
 if v_type !~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$' then v_type := 'application/octet-stream'; end if;
 -- Envios que ficaram pela metade (mais de um dia) somem da lista.
 delete from public.success_case_media where created_by = auth.uid() and status = 'uploading'
  and created_at < now() - interval '1 day';
 insert into public.success_case_media(id, company_id, case_id, name, content_type, size_bytes, path, pending, position, created_by)
 values (v_id, s.company_id, s.id, left(btrim(p_name), 255), v_type, p_size, 'cases/' || s.company_id || '/' || s.id || '/' || v_id,
  v_pending, coalesce((select max(position) + 1 from public.success_case_media where company_id = s.company_id and case_id = s.id), 0),
  auth.uid());
 return v_id;
end $$;

-- Onde enviar (só no servidor, que assina o PUT): da própria pessoa,
-- ainda enviando, preparado há menos de um dia.
create function public.success_case_upload_target(p_media uuid)
returns table(path text, content_type text, size_bytes bigint)
language sql stable security definer set search_path = '' as $$
 select m.path, m.content_type, m.size_bytes from public.success_case_media m
 where m.id = p_media and m.created_by = auth.uid() and m.status = 'uploading'
  and m.created_at > now() - interval '1 day' and mavi_private.member(m.company_id)
$$;

create function public.confirm_success_case_media(p_media uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 update public.success_case_media set status = 'ready'
 where id = p_media and created_by = auth.uid() and status = 'uploading';
 if not found then raise exception 'Mídia não encontrada' using errcode = '42501'; end if;
end $$;

-- Tira uma mídia. Devolve o caminho a apagar, ou null quando a remoção só
-- vale depois de a alteração ser aprovada.
create function public.delete_success_case_media(p_media uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare m public.success_case_media; s public.success_cases; begin
 select * into m from public.success_case_media where id = p_media for update;
 if not found then raise exception 'Mídia não encontrada' using errcode = 'P0002'; end if;
 select * into s from public.success_cases where company_id = m.company_id and id = m.case_id;
 if not mavi_private.case_can_edit(s) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if s.status = 'approved' and not m.pending and not mavi_private.leader(s.company_id) then
  if not exists (select 1 from public.success_case_drafts where case_id = s.id) then
   raise exception 'Salve a edição antes de tirar mídias.' using errcode = '22023';
  end if;
  update public.success_case_drafts set removed_media = array(select distinct x from unnest(removed_media || m.id) x),
   status = 'pending', review_note = null
  where case_id = s.id;
  return null;
 end if;
 delete from public.success_case_media where id = m.id;
 return m.path;
end $$;

-- Onde estão as mídias que a pessoa pode ver (o servidor assina o GET).
create function public.success_case_media_targets(p_ids uuid[])
returns table(id uuid, path text, name text, content_type text)
language sql stable security definer set search_path = '' as $$
 select m.id, m.path, m.name, m.content_type
 from public.success_case_media m join public.success_cases s on s.company_id = m.company_id and s.id = m.case_id
 where m.id = any(p_ids[1:100]) and m.status = 'ready' and mavi_private.case_can_see(s)
  and (not m.pending or mavi_private.case_can_edit(s))
$$;

-- ------------------------------------------------------------ ler
-- A lista da página: biblioteca (aprovados), meus cases ou a fila de
-- aprovação (líderes). Busca por todas as palavras, sem acento, no case e
-- no nome do cliente; nichos (qualquer um deles) e produtos filtram.
create function public.search_success_cases(p_company uuid, p_query text default '', p_niches text[] default null,
 p_products uuid[] default null, p_scope text default 'library', p_limit integer default 24, p_offset integer default 0)
returns table(id uuid, client_id uuid, client_name text, client_archived boolean, title text, summary text,
 highlights jsonb, niches text[], product_ids uuid[], status text, review_note text, created_by uuid, author_name text,
 created_at timestamptz, approved_at timestamptz, updated_at timestamptz, media_count integer, link_count integer,
 cover_id uuid, cover_type text, draft_status text, draft_note text, total bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_leader boolean; v_words text[]; v_niches text[]; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 v_leader := mavi_private.leader(p_company);
 if p_scope = 'review' and not v_leader then return; end if;
 v_words := array(select w from unnest(regexp_split_to_array(mavi_private.fold(btrim(left(coalesce(p_query, ''), 200))), '\s+')) w
  where w <> '');
 v_niches := case when cardinality(p_niches) > 0 then array(select mavi_private.fold(x) from unnest(p_niches) x) end;
 return query
 with base as (
  select s.*, cl.name as c_name, cl.archived as c_archived, d.status as d_status, d.review_note as d_note,
   d.submitted_by as d_by
  from public.success_cases s
  join public.clients cl on cl.company_id = s.company_id and cl.id = s.client_id
  left join public.success_case_drafts d on d.case_id = s.id
  where s.company_id = p_company
   and case p_scope
    when 'mine' then s.created_by = auth.uid() or d.submitted_by = auth.uid()
    when 'review' then s.status = 'pending' or d.status = 'pending'
    else s.status = 'approved' end
   and (s.status = 'approved' or s.created_by = auth.uid() or v_leader)
   and (v_niches is null or exists (select 1 from unnest(s.niches) n where mavi_private.fold(n) = any(v_niches)))
   and (cardinality(p_products) is null or cardinality(p_products) = 0 or s.product_ids && p_products)
   and not exists (select 1 from unnest(v_words) w
    where strpos(s.search, w) = 0 and strpos(mavi_private.fold(cl.name), w) = 0))
 select b.id, b.client_id, b.c_name, b.c_archived, b.title, b.summary, b.highlights, b.niches, b.product_ids, b.status,
  b.review_note, b.created_by, mavi_private.member_name(p_company, b.created_by), b.created_at, b.approved_at, b.updated_at,
  (select count(*)::integer from public.success_case_media m where m.company_id = b.company_id and m.case_id = b.id
    and m.status = 'ready' and not m.pending),
  jsonb_array_length(b.links),
  cv.id, cv.content_type,
  case when b.created_by = auth.uid() or b.d_by = auth.uid() or v_leader then b.d_status end,
  case when b.created_by = auth.uid() or b.d_by = auth.uid() or v_leader then b.d_note end,
  count(*) over ()
 from base b
 left join lateral (
  select m.id, m.content_type from public.success_case_media m
  where m.company_id = b.company_id and m.case_id = b.id and m.status = 'ready' and not m.pending
   and (m.content_type like 'image/%' or m.content_type like 'video/%') and m.content_type <> 'image/svg+xml'
  order by (m.content_type like 'image/%') desc, m.position, m.created_at limit 1) cv on true
 order by
  -- Com busca, o que bate no título vem antes.
  (cardinality(v_words) > 0 and not exists (select 1 from unnest(v_words) w where strpos(mavi_private.fold(b.title), w) = 0)) desc,
  case when p_scope = 'review' then coalesce(b.submitted_at, b.created_at) end asc nulls last,
  coalesce(b.approved_at, b.submitted_at) desc, b.id
 limit least(greatest(coalesce(p_limit, 24), 1), 60) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- Quantos esperam aprovação (o contador do menu para líderes).
create function public.success_case_review_count(p_company uuid) returns integer
language sql stable security definer set search_path = '' as $$
 select case when mavi_private.leader(p_company) then (
  select count(*)::integer from public.success_cases s
  where s.company_id = p_company and (s.status = 'pending'
   or exists (select 1 from public.success_case_drafts d where d.case_id = s.id and d.status = 'pending')))
 else 0 end
$$;

-- Os nichos em uso (com quantos cases aprovados) e os das campanhas, para
-- os filtros e o autocompletar.
create function public.success_case_niches(p_company uuid) returns table(niche text, cases integer)
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return query
 with used as (
  select n as x, 1 as w from public.success_cases s, unnest(s.niches) n where s.company_id = p_company and s.status = 'approved'
  union all
  select y.niche, 0 from public.ad_cycles y where y.company_id = p_company and btrim(y.niche) <> ''),
 grouped as (
  select mavi_private.fold(u.x) as k, sum(u.w)::integer as n,
   (array_agg(u.x order by u.w desc, u.x))[1] as label
  from used u group by mavi_private.fold(u.x))
 select g.label, g.n from grouped g order by g.n desc, g.label limit 300;
end $$;

-- Os clientes para escolher no case (todos da empresa, não só os que a
-- pessoa atende) e os produtos que cada um contrata, para sugerir.
create function public.success_case_clients(p_company uuid)
returns table(id uuid, name text, archived boolean, product_ids uuid[])
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 return query
 select cl.id, cl.name, cl.archived,
  coalesce((select array_agg(distinct k.product_id) from public.contracts k
   where k.company_id = cl.company_id and k.client_id = cl.id and not k.archived), '{}')
 from public.clients cl where cl.company_id = p_company
 order by cl.archived, cl.name;
end $$;

-- Tudo de um case para a tela: conteúdo, cliente, produtos, mídias, a
-- alteração que espera aprovação e o que a pessoa pode fazer.
create function public.success_case_detail(p_case uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.success_cases; d public.success_case_drafts; v_edit boolean; v_leader boolean; v_draft jsonb; begin
 select * into s from public.success_cases where id = p_case;
 if not found or not mavi_private.case_can_see(s) then return null; end if;
 v_edit := mavi_private.case_can_edit(s);
 v_leader := mavi_private.leader(s.company_id);
 select * into d from public.success_case_drafts where case_id = s.id;
 if d.case_id is not null and (v_leader or d.submitted_by = auth.uid() or s.created_by = auth.uid()) then
  v_draft := jsonb_build_object('content', d.content, 'removed_media', to_jsonb(d.removed_media), 'status', d.status,
   'review_note', d.review_note, 'submitted_by', d.submitted_by,
   'submitted_by_name', mavi_private.member_name(s.company_id, d.submitted_by), 'submitted_at', d.submitted_at,
   'client_name', (select name from public.clients where company_id = s.company_id and id = nullif(d.content->>'client_id', '')::uuid));
 end if;
 return jsonb_build_object(
  'id', s.id, 'company_id', s.company_id, 'client_id', s.client_id,
  'client_name', (select name from public.clients where company_id = s.company_id and id = s.client_id),
  'client_archived', (select archived from public.clients where company_id = s.company_id and id = s.client_id),
  'title', s.title, 'summary', s.summary, 'highlights', s.highlights, 'niches', to_jsonb(s.niches),
  'product_ids', to_jsonb(s.product_ids), 'links', s.links, 'contacts', s.contacts, 'status', s.status,
  'review_note', case when v_edit then s.review_note end,
  'created_by', s.created_by, 'author_name', mavi_private.member_name(s.company_id, s.created_by),
  'created_at', s.created_at, 'updated_at', s.updated_at, 'submitted_at', s.submitted_at, 'approved_at', s.approved_at,
  'reviewed_by_name', case when s.reviewed_by is not null then mavi_private.member_name(s.company_id, s.reviewed_by) end,
  'reviewed_at', s.reviewed_at, 'version', s.version,
  'share', case when v_edit then jsonb_build_object('enabled', s.share_enabled, 'token', s.share_token,
   'client', s.share_client, 'contacts', s.share_contacts, 'views', s.share_views) end,
  'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'content_type', m.content_type,
    'size_bytes', m.size_bytes, 'pending', m.pending, 'created_at', m.created_at) order by m.position, m.created_at)
   from public.success_case_media m where m.company_id = s.company_id and m.case_id = s.id and m.status = 'ready'
    and (not m.pending or v_edit)), '[]'),
  'draft', v_draft,
  'can_edit', v_edit, 'can_review', v_leader,
  'can_delete', v_leader or (s.created_by = auth.uid() and s.status <> 'approved'));
end $$;

-- ------------------------------------------------------------ link público
create function public.set_success_case_sharing(p_case uuid, p_enabled boolean, p_client boolean, p_contacts boolean,
 p_new_link boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.success_cases; begin
 select * into s from public.success_cases where id = p_case for update;
 if not found or not mavi_private.case_can_edit(s) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_enabled and s.status <> 'approved' then
  raise exception 'O link para o lead fica disponível depois que o case for aprovado.' using errcode = '22023';
 end if;
 update public.success_cases set share_enabled = coalesce(p_enabled, false), share_client = coalesce(p_client, true),
  share_contacts = coalesce(p_contacts, false),
  share_token = case when p_new_link
   then replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') else share_token end
 where id = s.id returning * into s;
 return jsonb_build_object('enabled', s.share_enabled, 'token', s.share_token, 'client', s.share_client,
  'contacts', s.share_contacts, 'views', s.share_views);
end $$;

-- O case aberto pelo link (sem login): só aprovado e com o link ligado,
-- sem as mídias que esperam aprovação; cliente e contatos só se escolhidos.
create function public.success_case_shared(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s public.success_cases; begin
 if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return null; end if;
 select * into s from public.success_cases where share_token = p_token;
 if not found or not s.share_enabled or s.status <> 'approved' then return null; end if;
 update public.success_cases set share_views = share_views + 1 where id = s.id;
 return jsonb_build_object(
  'title', s.title, 'summary', s.summary, 'highlights', s.highlights, 'niches', to_jsonb(s.niches),
  'links', s.links, 'approved_at', s.approved_at,
  'company', (select name from public.companies where id = s.company_id),
  'client', case when s.share_client then (select name from public.clients where company_id = s.company_id and id = s.client_id) end,
  'contacts', case when s.share_contacts then s.contacts else '[]'::jsonb end,
  'products', coalesce((select jsonb_agg(pr.name order by pr.name) from public.products pr
   where pr.company_id = s.company_id and pr.id = any(s.product_ids)), '[]'),
  'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'content_type', m.content_type,
    'size_bytes', m.size_bytes) order by m.position, m.created_at)
   from public.success_case_media m where m.company_id = s.company_id and m.case_id = s.id and m.status = 'ready'
    and not m.pending), '[]'));
end $$;

create function public.success_case_public_media(p_token text, p_ids uuid[])
returns table(id uuid, path text, name text, content_type text)
language sql stable security definer set search_path = '' as $$
 select m.id, m.path, m.name, m.content_type
 from public.success_cases s join public.success_case_media m on m.company_id = s.company_id and m.case_id = s.id
 where coalesce(p_token, '') ~ '^[0-9a-f]{64}$' and s.share_token = p_token and s.share_enabled and s.status = 'approved'
  and m.id = any(p_ids[1:100]) and m.status = 'ready' and not m.pending
$$;

-- ------------------------------------------------------------ MAVI
alter table public.ai_documents drop constraint ai_documents_source_type_check;
alter table public.ai_documents add constraint ai_documents_source_type_check
 check (source_type in ('meeting', 'task', 'drive_file', 'social_plan', 'social_briefing', 'campaign', 'success_case'));

-- O case aprovado como documento da MAVI, para todos da empresa (sem
-- cliente no trecho: quem não atende o cliente também acha o case).
create function mavi_private.case_index(p_case uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; v_header text; v_body text; v_pieces jsonb := '[]'; piece text; begin
 select s.*, cl.name as client_name, cl.archived as client_archived into r
 from public.success_cases s join public.clients cl on cl.company_id = s.company_id and cl.id = s.client_id
 where s.id = p_case;
 if not found or r.status <> 'approved' then perform mavi_private.ai_forget('success_case', p_case); return; end if;
 v_header := concat_ws(' · ', format('[Case de sucesso] "%s"', r.title),
  'cliente ' || r.client_name || case when r.client_archived then ' (ex-cliente)' else '' end,
  case when cardinality(r.niches) > 0 then 'nichos ' || array_to_string(r.niches, ', ') end,
  (select 'produtos ' || string_agg(pr.name, ', ' order by pr.name) from public.products pr
   where pr.company_id = r.company_id and pr.id = any(r.product_ids)),
  'aprovado em ' || to_char(r.approved_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'));
 v_body := concat_ws(E'\n\n',
  (select 'Resultados: ' || string_agg(btrim(concat_ws(' ', h->>'value', h->>'label')), '; ') from jsonb_array_elements(r.highlights) h),
  nullif(r.summary, ''),
  (select 'Links:' || E'\n' || string_agg('- ' || case when x->>'label' <> '' then (x->>'label') || ': ' else '' end || (x->>'url'), E'\n')
   from jsonb_array_elements(r.links) x),
  (select 'Contatos e textos:' || E'\n' || string_agg('- ' || case when x->>'label' <> '' then (x->>'label') || ': ' else '' end || (x->>'value'), E'\n')
   from jsonb_array_elements(r.contacts) x),
  (select 'Mídias: ' || string_agg(m.name, ', ' order by m.position) from public.success_case_media m
   where m.company_id = r.company_id and m.case_id = r.id and m.status = 'ready' and not m.pending));
 for piece in select mavi_private.ai_split(coalesce(nullif(v_body, ''), r.title)) loop
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', piece, 'meta', jsonb_build_object('kind', 'success_case')));
 end loop;
 perform mavi_private.ai_save_document(r.company_id, 'success_case', r.id, 'client', null, null, null, null,
  r.title, r.approved_at, v_header, v_pieces);
end $$;
revoke all on function mavi_private.case_index(uuid) from public, anon, authenticated;

create function mavi_private.case_index_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; begin
 if tg_table_name = 'success_cases' then
  if tg_op = 'DELETE' then perform mavi_private.ai_forget('success_case', old.id); return null; end if;
  v_id := new.id;
 elsif tg_table_name = 'clients' then
  perform mavi_private.case_index(s.id) from public.success_cases s where s.company_id = new.company_id and s.client_id = new.id;
  return null;
 else
  v_id := coalesce(new.case_id, old.case_id);
 end if;
 perform mavi_private.case_index(v_id);
 return null;
end $$;
revoke all on function mavi_private.case_index_trigger() from public, anon, authenticated;
-- Contar as visitas do link (share_views) não reconstrói nem avisa ninguém.
create trigger success_case_index after insert or delete or update of client_id, title, summary, highlights, niches, product_ids, links, contacts, status, review_note, approved_at on public.success_cases
 for each row execute function mavi_private.case_index_trigger();
create trigger success_case_media_index after update of status, pending or delete on public.success_case_media
 for each row execute function mavi_private.case_index_trigger();
create trigger success_case_client_index after update of name, archived on public.clients
 for each row when (old.name is distinct from new.name or old.archived is distinct from new.archived)
 execute function mavi_private.case_index_trigger();

-- ------------------------------------------------------------ avisos ao vivo
-- Só o id: cada tela pergunta de novo o que pode ver.
create function mavi_private.broadcast_success_case() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 r := coalesce(new, old);
 perform mavi_private.broadcast(r.company_id, jsonb_build_object('kind', 'cases', 'table', tg_table_name,
  'case', coalesce(to_jsonb(r)->>'case_id', to_jsonb(r)->>'id')));
 return null;
end $$;
revoke all on function mavi_private.broadcast_success_case() from public, anon, authenticated;
create trigger broadcast_success_case after insert or delete or update of client_id, title, summary, highlights, niches, product_ids, links, contacts, status, review_note, approved_at,
 share_enabled, share_client, share_contacts, share_token on public.success_cases
 for each row execute function mavi_private.broadcast_success_case();
create trigger broadcast_success_case_draft after insert or update or delete on public.success_case_drafts
 for each row execute function mavi_private.broadcast_success_case();
create trigger broadcast_success_case_media after update of status, pending or delete on public.success_case_media
 for each row execute function mavi_private.broadcast_success_case();

-- ------------------------------------------------------------ módulos
alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
alter table public.memberships add constraint memberships_hidden_pages_check
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases']::text[]);

create or replace function public.set_member_pages(p_company uuid, p_user uuid, p_hidden text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v text[]; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores escolhem os módulos de cada pessoa.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = p_user) then
  raise exception 'Usuário não encontrado na empresa';
 end if;
 select coalesce(array_agg(distinct x order by x), '{}') into v from unnest(coalesce(p_hidden, '{}')) x;
 if not v <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
  and hidden_pages is distinct from v;
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function public.save_success_case(uuid, uuid, jsonb, integer),
 public.review_success_case(uuid, boolean, text), public.discard_success_case_draft(uuid),
 public.delete_success_case(uuid), public.prepare_success_case_media(uuid, text, bigint, text),
 public.success_case_upload_target(uuid), public.confirm_success_case_media(uuid),
 public.delete_success_case_media(uuid), public.success_case_media_targets(uuid[]),
 public.search_success_cases(uuid, text, text[], uuid[], text, integer, integer),
 public.success_case_review_count(uuid), public.success_case_niches(uuid), public.success_case_detail(uuid),
 public.success_case_clients(uuid),
 public.set_success_case_sharing(uuid, boolean, boolean, boolean, boolean),
 public.success_case_shared(text), public.success_case_public_media(text, uuid[]) from public, anon, authenticated;
grant execute on function public.save_success_case(uuid, uuid, jsonb, integer),
 public.review_success_case(uuid, boolean, text), public.discard_success_case_draft(uuid),
 public.delete_success_case(uuid), public.prepare_success_case_media(uuid, text, bigint, text),
 public.success_case_upload_target(uuid), public.confirm_success_case_media(uuid),
 public.delete_success_case_media(uuid), public.success_case_media_targets(uuid[]),
 public.search_success_cases(uuid, text, text[], uuid[], text, integer, integer),
 public.success_case_review_count(uuid), public.success_case_niches(uuid), public.success_case_detail(uuid),
 public.success_case_clients(uuid),
 public.set_success_case_sharing(uuid, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function public.success_case_shared(text), public.success_case_public_media(text, uuid[])
 to anon, authenticated;

commit;
