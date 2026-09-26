begin;

-- Social Leads: a descrição das tarefas de arte passa a ser texto formatado
-- (cada tópico com título em negrito, formato e chamada em lista e os passos
-- de entrega numerados), no mesmo formato do editor de descrição
-- (mavi:richtext:v1:, só com blocos e marcas que o app aceita). O acesso ao
-- post fica no botão "Abrir o post no plano" dos detalhes da tarefa, que o
-- app mostra para as tarefas ligadas a um post (social_leads_posts.task_id).

-- Um texto com quebras de linha vira texto e quebras (hardBreak).
create function mavi_private.social_leads_rich_lines(p_text text, p_marks jsonb default '[]') returns jsonb
language sql immutable set search_path = '' as $$
 select coalesce(jsonb_agg(node order by n, k), '[]'::jsonb)
 from unnest(string_to_array(trim(p_text), E'\n')) with ordinality as l(line, n)
 cross join lateral (values
  (1, case when n > 1 then jsonb_build_object('type', 'hardBreak') end),
  (2, case when trim(line) <> '' then jsonb_build_object('type', 'text', 'text', trim(line), 'marks', p_marks) end)
 ) as v(k, node)
 where node is not null
$$;

-- Um tópico: título em negrito e, na linha de baixo, o texto.
create function mavi_private.social_leads_rich_topic(p_label text, p_text text) returns jsonb
language sql immutable set search_path = '' as $$
 select case when nullif(trim(p_text), '') is not null then jsonb_build_object('type', 'paragraph', 'content',
  jsonb_build_array(
   jsonb_build_object('type', 'text', 'text', p_label, 'marks', '[{"type":"bold"}]'::jsonb),
   jsonb_build_object('type', 'hardBreak'))
  || mavi_private.social_leads_rich_lines(p_text)) end
$$;

-- Um item de lista: "Rótulo: texto", com o rótulo em negrito.
create function mavi_private.social_leads_rich_item(p_label text, p_text text) returns jsonb
language sql immutable set search_path = '' as $$
 select case when nullif(trim(p_text), '') is not null then jsonb_build_object('type', 'listItem', 'content',
  jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content',
   jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_label || ': ', 'marks', '[{"type":"bold"}]'::jsonb))
   || mavi_private.social_leads_rich_lines(p_text)))) end
$$;

create function mavi_private.social_leads_rich_paragraph(p_text text, p_marks jsonb default '[]') returns jsonb
language sql immutable set search_path = '' as $$
 select jsonb_build_object('type', 'paragraph', 'content', mavi_private.social_leads_rich_lines(p_text, p_marks))
$$;

-- A lista (com ou sem número) só com os itens que existem.
create function mavi_private.social_leads_rich_list(p_type text, p_items jsonb[]) returns jsonb
language sql immutable set search_path = '' as $$
 select case when count(i) > 0 then jsonb_build_object('type', p_type, 'content', jsonb_agg(i order by n)) end
 from unnest(p_items) with ordinality as u(i, n) where i is not null
$$;

-- A descrição texto de antes (para achar as tarefas que ninguém editou).
create function mavi_private.social_leads_task_text_v1(x public.social_leads_posts, p_label text) returns text
language sql immutable set search_path = '' as $$
 select concat_ws(E'\n',
  'Gancho: ' || x.hook,
  'Direção de copy: ' || x.copy_direction,
  'Direção visual: ' || x.visual_direction,
  'Formato: ' || x.format,
  'CTA: ' || x.cta,
  case when x.is_ad then 'Este post também vira o anúncio do mês.' end,
  case when nullif(x.note, '') is not null then 'Observação do cliente: ' || x.note end,
  '',
  'Suba as artes no próprio post: Onboarding › Social Leads › ' || p_label || ' › Post ' || x.number || '.')
$$;

create or replace function mavi_private.social_leads_task_text(x public.social_leads_posts, p_label text) returns text
language sql immutable set search_path = '' as $$
 select 'mavi:richtext:v1:' || jsonb_build_object('type', 'doc', 'content', (
  select jsonb_agg(b order by n) from unnest(array[
   case when x.is_ad then mavi_private.social_leads_rich_paragraph(
    'Este post também vira o anúncio do mês.', '[{"type":"bold"},{"type":"highlight"}]') end,
   mavi_private.social_leads_rich_topic('Gancho', x.hook),
   mavi_private.social_leads_rich_topic('Direção de copy', x.copy_direction),
   mavi_private.social_leads_rich_topic('Direção visual', x.visual_direction),
   mavi_private.social_leads_rich_list('bulletList', array[
    mavi_private.social_leads_rich_item('Formato', x.format),
    mavi_private.social_leads_rich_item('Chamada (CTA)', x.cta)]),
   mavi_private.social_leads_rich_topic('Observação do cliente', x.note),
   mavi_private.social_leads_rich_paragraph('Como entregar', '[{"type":"bold"}]'),
   mavi_private.social_leads_rich_list('orderedList', array[
    jsonb_build_object('type', 'listItem', 'content', jsonb_build_array(mavi_private.social_leads_rich_paragraph(
     'Clique em “Abrir o post no plano”, logo abaixo desta descrição.'))),
    jsonb_build_object('type', 'listItem', 'content', jsonb_build_array(mavi_private.social_leads_rich_paragraph(
     'No post, use “Enviar as artes” (imagem, vídeo ou PDF). Elas vão para o Drive do cliente e aparecem no link de aprovação.'))),
    jsonb_build_object('type', 'listItem', 'content', jsonb_build_array(mavi_private.social_leads_rich_paragraph(
     'Só conclua esta tarefa depois que as artes estiverem no post.')))]),
   mavi_private.social_leads_rich_paragraph(
    'Onde fica: Onboarding › Social Leads › ' || p_label || ' › Post ' || x.number, '[{"type":"italic"}]')
  ]) with ordinality as u(b, n) where b is not null))::text
$$;

revoke all on function mavi_private.social_leads_rich_lines(text, jsonb) from public, anon, authenticated;
revoke all on function mavi_private.social_leads_rich_topic(text, text) from public, anon, authenticated;
revoke all on function mavi_private.social_leads_rich_item(text, text) from public, anon, authenticated;
revoke all on function mavi_private.social_leads_rich_paragraph(text, jsonb) from public, anon, authenticated;
revoke all on function mavi_private.social_leads_rich_list(text, jsonb[]) from public, anon, authenticated;
revoke all on function mavi_private.social_leads_task_text(public.social_leads_posts, text) from public, anon, authenticated;

-- As tarefas já criadas ganham a descrição nova, se ninguém mexeu nela.
update public.tasks t set description = mavi_private.social_leads_task_text(x, p.label)
from public.social_leads_posts x join public.social_leads_plans p on p.id = x.plan_id
where t.id = x.task_id and t.description = mavi_private.social_leads_task_text_v1(x, p.label);
drop function mavi_private.social_leads_task_text_v1(public.social_leads_posts, text);

-- O botão da tarefa procura o post por ela.
create index if not exists social_leads_posts_task on public.social_leads_posts(task_id) where task_id is not null;

commit;
