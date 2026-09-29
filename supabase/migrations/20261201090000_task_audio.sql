begin;

-- Áudio na descrição das tarefas e anexos de qualquer tipo.
--
-- Áudios (public.task_audios): quem cria ou edita a tarefa grava áudios de
-- até 5 minutos, em lista, ao lado da descrição em texto; nos comentários,
-- um áudio por comentário. Todo áudio nasce rascunho (sem tarefa): o
-- navegador prepara o registro, envia o arquivo ao GCS (api/_uploads.ts,
-- só para o caminho deste registro), confirma o envio e pede a transcrição
-- (/api/drive, ação "task-audio"). Depois o rascunho entra numa tarefa
-- (bind_task_audios, ao criar a tarefa ou na edição) ou num comentário
-- (add_audio_comment). Assim a transcrição fica pronta ainda no formulário
-- de criação, e o Assistente MAVI já lê o que foi dito.
--
-- A MAVI transcreve (OpenAI) e, nos áudios da descrição, resume em tópicos
-- (funcionalidade 'task_audio' do Painel da MAVI). Quem edita a tarefa
-- corrige a transcrição, e o resumo é refeito. A transcrição entra na busca
-- das tarefas e no RAG. Nas tarefas que se repetem, cada cópia leva os áudios
-- da descrição: as cópias apontam para o mesmo arquivo, que só sai do GCS
-- quando nenhum registro aponta mais para ele.
--
-- Anexos: qualquer tipo, exceto executáveis, até 100 MB.

-- ------------------------------------------------------------ anexos
alter table public.attachments drop constraint attachments_size_bytes_check;
alter table public.attachments add constraint attachments_size_bytes_check
 check (size_bytes between 1 and 104857600);

-- Executáveis e scripts que o sistema abre sozinho (a mesma lista de
-- src/upload-types.ts, que o navegador e o servidor de envio conferem).
create function mavi_private.blocked_file(p_name text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(lower(substring(p_name from '\.([^./\\]+)$')), '') = any (array[
  'exe','msi','msp','mst','bat','cmd','com','scr','pif','cpl','dll','sys','drv','ocx','vbs','vbe','vb',
  'js','jse','wsf','wsh','wsc','ws','hta','ps1','ps1xml','ps2','psc1','psc2','psm1','msc','msh','msh1',
  'msh2','reg','inf','lnk','scf','jar','jnlp','appx','appxbundle','msix','msixbundle','apk','xapk','aab',
  'ipa','app','command','sh','bash','csh','ksh','run','bin','pkg','deb','rpm','gadget','application',
  'xbap','ade','adp','chm','ins','isp','shb','shs','sct','xll','mde','mdb','accde','diagcab'])
$$;
revoke all on function mavi_private.blocked_file(text) from public, anon, authenticated;

create or replace function public.prepare_attachment(p_task uuid, p_name text, p_size bigint) returns public.attachments
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; a public.attachments; aid uuid := gen_random_uuid(); begin
 select * into t from public.tasks where id = p_task;
 if not found or not mavi_private.task_access(t.company_id, t.id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if length(trim(coalesce(p_name, ''))) not between 1 and 240 then
  raise exception 'Nome de arquivo inválido' using errcode = '22023';
 end if;
 if mavi_private.blocked_file(p_name) then
  raise exception 'Por segurança, programas e scripts (.exe, .bat, .sh, .apk…) não podem ser anexados. Compacte em ZIP se precisar enviar.'
   using errcode = '22023';
 end if;
 insert into public.attachments(id, company_id, task_id, name, path, size_bytes)
 values (aid, t.company_id, t.id, p_name, t.company_id::text || '/' || t.id::text || '/' || aid::text, p_size)
 returning * into a;
 return a;
end $$;

-- ------------------------------------------------------------ áudios
create table public.task_audios (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 -- Nulo enquanto é rascunho (a tarefa ainda não existe ou o comentário
 -- ainda não foi enviado).
 task_id uuid,
 comment_id uuid references public.comments(id) on delete cascade,
 -- 'description': resumido pela MAVI; 'comment': só transcrito.
 purpose text not null check (purpose in ('description', 'comment')),
 uploaded_by uuid not null default auth.uid(),
 -- <empresa>/audio/<id do áudio gravado>: as cópias da repetição apontam
 -- para o mesmo objeto.
 path text not null,
 mime text not null check (mime in ('audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav')),
 size_bytes bigint not null check (size_bytes between 1 and 20971520),
 -- Até 5 minutos (e um pouco de folga para o fim da gravação).
 duration_seconds numeric(6,1) not null check (duration_seconds > 0 and duration_seconds <= 305),
 position integer not null default 0,
 -- uploading → transcribing → (summarizing →) ready | empty | failed
 status text not null default 'uploading'
  check (status in ('uploading', 'transcribing', 'summarizing', 'ready', 'empty', 'failed')),
 transcript text check (length(transcript) <= 20000),
 summary text check (length(summary) <= 3000),
 error text check (length(error) <= 500),
 -- Quando o servidor pegou o áudio para trabalhar (evita dois ao mesmo tempo).
 working_at timestamptz,
 edited_by uuid,
 edited_at timestamptz,
 status_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 foreign key (company_id, task_id) references public.tasks(company_id, id),
 check (comment_id is null or (task_id is not null and purpose = 'comment'))
);
create index task_audios_task on public.task_audios(company_id, task_id, position, created_at) where task_id is not null;
create index task_audios_path on public.task_audios(path);
create index task_audios_drafts on public.task_audios(uploaded_by, created_at) where task_id is null;

-- Quem vê a tarefa ouve os áudios dela; o rascunho, só quem gravou.
alter table public.task_audios enable row level security;
revoke all on public.task_audios from public, anon, authenticated;
grant select on public.task_audios to authenticated;
create policy task_audios_read on public.task_audios for select to authenticated using (
 case when task_id is null
  then uploaded_by = (select auth.uid()) and company_id in (select mavi_private.active_companies())
  else exists (select 1 from public.tasks t where t.company_id = task_audios.company_id and t.id = task_audios.task_id)
 end);

-- Quem cuida de um áudio: o rascunho, quem gravou; o da descrição, quem
-- edita a tarefa; o de um comentário, quem o escreveu (ou um gestor).
create function mavi_private.audio_manager(a public.task_audios) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.member(a.company_id) and case
  when a.task_id is null then a.uploaded_by = auth.uid()
  when a.comment_id is null then mavi_private.can_edit(a.company_id, a.task_id)
  else mavi_private.task_access(a.company_id, a.task_id) and (mavi_private.leader(a.company_id)
   or exists (select 1 from public.comments c where c.id = a.comment_id and c.author_id = auth.uid()))
 end
$$;
revoke all on function mavi_private.audio_manager(public.task_audios) from public, anon, authenticated;

-- O rascunho de um áudio gravado (antes de enviar o arquivo).
create function public.prepare_task_audio(p_company uuid, p_purpose text, p_mime text, p_size bigint,
 p_duration numeric) returns public.task_audios
language plpgsql security definer set search_path = '' as $$
declare result public.task_audios; aid uuid := gen_random_uuid(); v_mime text := lower(split_part(coalesce(p_mime, ''), ';', 1)); begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_purpose not in ('description', 'comment') then raise exception 'Áudio inválido' using errcode = '22023'; end if;
 if v_mime not in ('audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav') then
  raise exception 'Formato de áudio não suportado' using errcode = '22023';
 end if;
 if p_duration is null or p_duration <= 0 or p_duration > 305 then
  raise exception 'Cada áudio pode ter até 5 minutos' using errcode = '22023';
 end if;
 if p_size is null or p_size < 1 or p_size > 20971520 then
  raise exception 'Áudio grande demais' using errcode = '22023';
 end if;
 if (select count(*) from public.task_audios where uploaded_by = auth.uid() and task_id is null
     and created_at > now() - interval '1 day') >= 60 then
  raise exception 'Muitos áudios gravados sem tarefa hoje. Crie a tarefa ou descarte os rascunhos.' using errcode = '54000';
 end if;
 insert into public.task_audios(id, company_id, purpose, path, mime, size_bytes, duration_seconds)
 values (aid, p_company, p_purpose, p_company::text || '/audio/' || aid::text, v_mime, p_size, round(p_duration, 1))
 returning * into result;
 return result;
end $$;

-- Para o servidor de envio: o caminho do rascunho que a pessoa acabou de
-- preparar (e ainda não enviou).
create function public.task_audio_upload_target(p_audio uuid) returns table(path text, mime text, size_bytes bigint)
language sql stable security definer set search_path = '' as $$
 select a.path, a.mime, a.size_bytes from public.task_audios a
 where a.id = p_audio and a.uploaded_by = auth.uid() and a.task_id is null and a.status = 'uploading'
  and a.created_at > now() - interval '15 minutes' and mavi_private.member(a.company_id)
$$;

-- O arquivo chegou ao GCS: o áudio espera a transcrição.
create function public.confirm_task_audio(p_audio uuid) returns public.task_audios
language plpgsql security definer set search_path = '' as $$
declare a public.task_audios; begin
 select * into a from public.task_audios where id = p_audio for update;
 if not found or a.uploaded_by <> auth.uid() or not mavi_private.member(a.company_id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if a.status = 'uploading' then
  update public.task_audios set status = 'transcribing', status_at = now() where id = a.id returning * into a;
 end if;
 return a;
end $$;

-- Os rascunhos entram na descrição da tarefa, nesta ordem, depois dos que
-- ela já tem (ao criar a tarefa ou na edição).
create function public.bind_task_audios(p_task uuid, p_audios uuid[]) returns setof public.task_audios
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; a public.task_audios; next_pos integer; i integer := 0; begin
 select * into t from public.tasks where id = p_task;
 if not found or not mavi_private.can_edit(t.company_id, t.id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select coalesce(max(position), -1) + 1 into next_pos from public.task_audios
  where company_id = t.company_id and task_id = t.id and comment_id is null;
 if next_pos + coalesce(array_length(p_audios, 1), 0) > 20 then
  raise exception 'A descrição pode ter até 20 áudios' using errcode = '22023';
 end if;
 for a in select x.* from unnest(coalesce(p_audios, '{}')) with ordinality as u(id, n)
   join public.task_audios x on x.id = u.id order by u.n for update of x loop
  if a.uploaded_by <> auth.uid() or a.company_id <> t.company_id or a.task_id is not null
   or a.purpose <> 'description' then
   raise exception 'Áudio inválido' using errcode = '22023';
  end if;
  if a.status = 'uploading' then raise exception 'O áudio ainda está sendo enviado' using errcode = '55000'; end if;
  update public.task_audios set task_id = t.id, position = next_pos + i where id = a.id returning * into a;
  i := i + 1;
  return next a;
 end loop;
 if i > 0 then
  insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (t.company_id, t.id, auth.uid(), 'audio_added', jsonb_build_object('count', i));
 end if;
end $$;

-- A descrição de um comentário pode ficar vazia quando ele leva um áudio
-- (add_audio_comment); os comentários só de texto continuam exigindo texto.
alter table public.comments drop constraint comments_body_check;
alter table public.comments add constraint comments_body_check check (length(trim(body)) <= 10000);

create or replace function public.add_comment(p_task uuid, p_body text, p_parent uuid default null)
returns public.comments
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; root uuid; result public.comments; begin
 select * into t from public.tasks where id = p_task;
 if not found or not mavi_private.task_access(t.company_id, t.id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if length(trim(coalesce(p_body, ''))) = 0 then
  raise exception 'Escreva o comentário' using errcode = '23514';
 end if;
 if p_parent is not null then
  select coalesce(c.parent_id, c.id) into root from public.comments c
  where c.company_id = t.company_id and c.task_id = t.id and c.id = p_parent;
  if root is null then
   raise exception 'O comentário respondido não existe nesta tarefa' using errcode = '22023';
  end if;
 end if;
 insert into public.comments(company_id, task_id, body, parent_id)
 values (t.company_id, t.id, trim(p_body), root) returning * into result;
 return result;
end $$;

-- Um comentário com áudio (e texto, se a pessoa escreveu): o rascunho
-- enviado entra no comentário.
create function public.add_audio_comment(p_task uuid, p_body text, p_parent uuid, p_audio uuid)
returns public.comments
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; a public.task_audios; root uuid; result public.comments; begin
 select * into t from public.tasks where id = p_task;
 if not found or not mavi_private.task_access(t.company_id, t.id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select * into a from public.task_audios where id = p_audio for update;
 if not found or a.uploaded_by <> auth.uid() or a.company_id <> t.company_id or a.task_id is not null
  or a.purpose <> 'comment' then
  raise exception 'Áudio inválido' using errcode = '22023';
 end if;
 if a.status = 'uploading' then raise exception 'O áudio ainda está sendo enviado' using errcode = '55000'; end if;
 if p_parent is not null then
  select coalesce(c.parent_id, c.id) into root from public.comments c
  where c.company_id = t.company_id and c.task_id = t.id and c.id = p_parent;
  if root is null then
   raise exception 'O comentário respondido não existe nesta tarefa' using errcode = '22023';
  end if;
 end if;
 insert into public.comments(company_id, task_id, body, parent_id)
 values (t.company_id, t.id, trim(coalesce(p_body, '')), root) returning * into result;
 update public.task_audios set task_id = t.id, comment_id = result.id where id = a.id;
 return result;
end $$;

-- Tira um áudio (ou descarta um rascunho). Devolve o caminho do arquivo
-- quando nenhum outro registro aponta para ele (o servidor apaga do GCS).
create function public.delete_task_audio(p_audio uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare a public.task_audios; begin
 select * into a from public.task_audios where id = p_audio for update;
 if not found or not mavi_private.audio_manager(a) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 delete from public.task_audios where id = a.id;
 -- Um comentário que era só o áudio sai junto (se ninguém respondeu).
 if a.comment_id is not null then
  delete from public.comments c where c.id = a.comment_id and length(trim(c.body)) = 0
   and not exists (select 1 from public.comments r where r.parent_id = c.id);
 end if;
 if a.task_id is not null and a.comment_id is null then
  insert into public.task_events(company_id, task_id, actor_id, action, detail)
  values (a.company_id, a.task_id, auth.uid(), 'audio_deleted',
   jsonb_build_object('seconds', a.duration_seconds));
 end if;
 if exists (select 1 from public.task_audios where path = a.path) then return null; end if;
 return a.path;
end $$;

-- Correção da transcrição: o resumo é refeito (a MAVI, pelo servidor).
create function public.edit_task_audio(p_audio uuid, p_transcript text) returns public.task_audios
language plpgsql security definer set search_path = '' as $$
declare a public.task_audios; v_text text := btrim(coalesce(p_transcript, '')); begin
 select * into a from public.task_audios where id = p_audio for update;
 if not found or not mavi_private.audio_manager(a) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if a.status in ('uploading', 'transcribing') then
  raise exception 'Espere a MAVI terminar a transcrição' using errcode = '55000';
 end if;
 if length(v_text) > 20000 then raise exception 'Transcrição longa demais' using errcode = '22023'; end if;
 update public.task_audios set transcript = nullif(v_text, ''), summary = null, error = null,
  edited_by = auth.uid(), edited_at = now(), working_at = null, status_at = now(),
  status = case when v_text = '' then 'empty' when purpose = 'description' then 'summarizing' else 'ready' end
 where id = a.id returning * into a;
 return a;
end $$;

-- O servidor pega o áudio para transcrever ou resumir (como a pessoa que
-- pediu). Nada se ainda está sendo enviado, já está pronto, ou outro
-- pedido começou há menos de 3 minutos.
create function public.start_task_audio_work(p_audio uuid, p_contract uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.task_audios; k public.contracts; v_contract uuid := p_contract; v_project uuid; begin
 select * into a from public.task_audios where id = p_audio for update;
 if not found or not (mavi_private.audio_manager(a) or a.uploaded_by = auth.uid() and mavi_private.member(a.company_id)) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if a.status = 'uploading' then raise exception 'O áudio ainda está sendo enviado' using errcode = '55000'; end if;
 -- Pronto não volta, a não ser o resumo que falhou.
 if a.status in ('ready', 'empty') and not (a.purpose = 'description' and a.status = 'ready'
   and a.summary is null and a.error is not null) then
  return jsonb_build_object('skip', true, 'audio', to_jsonb(a));
 end if;
 if a.working_at is not null and a.working_at > now() - interval '3 minutes' then
  return jsonb_build_object('skip', true, 'audio', to_jsonb(a));
 end if;
 update public.task_audios set working_at = now(), error = null, status_at = now(),
  status = case when transcript is null then 'transcribing'
   when purpose = 'description' then 'summarizing' else 'ready' end
 where id = a.id returning * into a;
 -- Qual cliente (as regras do Painel da MAVI e o consumo): o da tarefa, ou
 -- o produto escolhido no formulário de criação.
 if a.task_id is not null then
  select t.contract_id, t.project_id into v_contract, v_project from public.tasks t
  where t.company_id = a.company_id and t.id = a.task_id;
 end if;
 if v_contract is not null then
  select * into k from public.contracts where company_id = a.company_id and id = v_contract;
 end if;
 return jsonb_build_object('skip', false, 'audio', to_jsonb(a),
  'client', k.client_id, 'contract', k.id, 'project', v_project,
  'task_title', (select title from public.tasks where company_id = a.company_id and id = a.task_id));
end $$;

-- O resultado do servidor: a transcrição (e o próximo passo) ou o resumo.
create function public.save_task_audio_work(p_audio uuid, p_transcript text, p_summary text, p_error text)
returns public.task_audios
language plpgsql security definer set search_path = '' as $$
declare a public.task_audios; v_text text; begin
 select * into a from public.task_audios where id = p_audio for update;
 if not found or not (mavi_private.audio_manager(a) or a.uploaded_by = auth.uid() and mavi_private.member(a.company_id)) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if p_error is not null then
  -- Sem transcrição, o áudio falhou; sem resumo, a transcrição continua valendo.
  update public.task_audios set error = left(p_error, 500), working_at = null, status_at = now(),
   status = case when transcript is null then 'failed' else 'ready' end
  where id = a.id returning * into a;
  return a;
 end if;
 if p_transcript is not null then
  v_text := left(btrim(p_transcript), 20000);
  update public.task_audios set transcript = nullif(v_text, ''), status_at = now(),
   status = case when v_text = '' then 'empty' when purpose = 'description' then 'summarizing' else 'ready' end,
   working_at = case when v_text <> '' and purpose = 'description' then working_at end
  where id = a.id returning * into a;
  return a;
 end if;
 update public.task_audios set summary = nullif(left(btrim(coalesce(p_summary, '')), 3000), ''),
  status = case when transcript is null then 'empty' else 'ready' end, working_at = null, status_at = now()
 where id = a.id returning * into a;
 return a;
end $$;

do $$ declare f text; begin
 foreach f in array array[
  'public.prepare_task_audio(uuid,text,text,bigint,numeric)', 'public.task_audio_upload_target(uuid)',
  'public.confirm_task_audio(uuid)', 'public.bind_task_audios(uuid,uuid[])',
  'public.add_audio_comment(uuid,text,uuid,uuid)', 'public.delete_task_audio(uuid)',
  'public.edit_task_audio(uuid,text)', 'public.start_task_audio_work(uuid,uuid)',
  'public.save_task_audio_work(uuid,text,text,text)'] loop
  execute format('revoke all on function %s from public, anon', f);
  execute format('grant execute on function %s to authenticated', f);
 end loop;
end $$;

-- ------------------------------------------------------------ ao vivo
-- Um áudio da tarefa mudou (entrou, foi transcrito, saiu): quem está com a
-- tarefa aberta recarrega os detalhes. Rascunhos não avisam ninguém.
create function mavi_private.broadcast_task_audio() returns trigger
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; v_company uuid; v_task uuid; begin
 v_company := coalesce(new.company_id, old.company_id);
 -- Ao entrar numa tarefa, o rascunho avisa a tarefa nova.
 v_task := coalesce(new.task_id, old.task_id);
 if v_task is null then return null; end if;
 select * into t from public.tasks where company_id = v_company and id = v_task;
 perform mavi_private.broadcast(v_company, jsonb_build_object(
  'kind', 'extras', 'op', lower(tg_op), 'task', v_task,
  'users', to_jsonb(case when t.id is null then '{}'::uuid[] else mavi_private.task_people(t) end)));
 return null;
end $$;
revoke all on function mavi_private.broadcast_task_audio() from public, anon, authenticated;
create trigger broadcast_task_audio after insert or update or delete on public.task_audios
 for each row execute function mavi_private.broadcast_task_audio();

-- Os detalhes da tarefa trazem os áudios (da descrição e dos comentários).
create or replace function public.task_extras(p_task uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare c uuid; rec uuid; begin
 select company_id, recurrence_id into c, rec from public.tasks where id=p_task;
 if not found then raise exception 'Sem acesso à tarefa' using errcode='42501'; end if;
 return jsonb_build_object(
 'comments',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from public.comments where company_id=c and task_id=p_task order by created_at desc,id desc limit 100) r),
 'attachments',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from public.attachments where company_id=c and task_id=p_task order by created_at desc,id desc limit 100) r),
 'events',(select coalesce(jsonb_agg(r order by r.created_at desc,r.id desc),'[]'::jsonb) from
   (select * from public.task_events where company_id=c and task_id=p_task order by created_at desc,id desc limit 100) r),
 'audios',(select coalesce(jsonb_agg(to_jsonb(r) - 'working_at' order by r.position, r.created_at, r.id),'[]'::jsonb) from
   (select * from public.task_audios where company_id=c and task_id=p_task order by position, created_at, id limit 200) r),
 'recurrence',(select jsonb_build_object('id',r.id,'frequency',r.frequency,'next_run',r.next_run,'active',r.active,
   'creator_id',r.creator_id,'copies',r.copies,'last_error',r.last_error)
   from public.task_recurrences r where r.company_id=c and r.id=rec));
end $$;

-- ------------------------------------------------------------ repetição
-- Cada cópia leva os áudios da descrição da tarefa de origem (o mesmo
-- arquivo, a mesma transcrição e o mesmo resumo). Os anexos continuam sem
-- ser copiados.
create function mavi_private.copy_recurrence_audios() returns trigger
language plpgsql security definer set search_path = '' as $$
declare src uuid; begin
 select r.source_task_id into src from public.task_recurrences r
 where r.company_id = new.company_id and r.id = new.recurrence_id;
 if src is null or src = new.id then return null; end if;
 insert into public.task_audios(company_id, task_id, purpose, uploaded_by, path, mime, size_bytes,
  duration_seconds, position, status, transcript, summary, edited_by, edited_at)
 select a.company_id, new.id, 'description', a.uploaded_by, a.path, a.mime, a.size_bytes, a.duration_seconds,
  a.position, case when a.status in ('ready', 'empty') then a.status else 'failed' end,
  a.transcript, a.summary, a.edited_by, a.edited_at
 from public.task_audios a
 where a.company_id = new.company_id and a.task_id = src and a.comment_id is null and a.status <> 'uploading';
 return null;
end $$;
revoke all on function mavi_private.copy_recurrence_audios() from public, anon, authenticated;
create trigger copy_recurrence_audios after insert on public.tasks
 for each row when (new.recurrence_id is not null)
 execute function mavi_private.copy_recurrence_audios();

-- ------------------------------------------------------------ MAVI
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask', 'whatsapp_task',
   'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio')));

create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text,
 p_feature text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_type in ('company', 'feature') then null else p_id end;
 v_feature text := case when p_type = 'feature' then p_feature end; v_kind text; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project', 'feature') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if p_type not in ('company', 'feature') and p_id is null then
  raise exception 'Escolha para quem vale a regra.' using errcode = '22023';
 end if;
 if p_type = 'feature' and coalesce(v_feature, '') not in ('assistant', 'meetings_history', 'meetings_ask',
  'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
  'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
  'client_temperature', 'client_temperature_text', 'task_audio') then
  raise exception 'Funcionalidade inválida.' using errcode = '22023';
 end if;
 if p_provider is null then
  delete from mavi_private.ai_routes where company_id = p_company and scope_type = p_type
   and scope_id is not distinct from v_id and feature is not distinct from v_feature;
  return;
 end if;
 select p.kind into v_kind from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
  and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model);
 if v_kind is null then
  raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
 end if;
 -- O termômetro lê com o Jev pelo OpenRouter; o Jev não conversa.
 if v_feature = 'client_temperature' and not (v_kind = 'openrouter' and mavi_private.jev_model(p_model)) then
  raise exception 'O termômetro usa o Jev (TypeSafe) pelo OpenRouter: escolha o modelo do Jev.' using errcode = '22023';
 end if;
 if coalesce(v_feature, '') <> 'client_temperature' and mavi_private.jev_model(p_model) then
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro do cliente.' using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id)
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, feature, provider_id, model)
 values (p_company, p_type, v_id, v_feature, p_provider, p_model)
 on conflict on constraint ai_routes_scope_key do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;

-- O RAG lê o que foi dito: os áudios da descrição junto da descrição, e os
-- dos comentários junto do comentário.
create or replace function mavi_private.ai_build_task(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t record; v_pieces jsonb := '[]'; v_body text; v_comments text; v_header text; piece text; begin
 select x.*, k.client_id, cl.name as client_name, coalesce(nullif(p.name, ''), k.name) as product_name,
  pj.name as project_name
  into t from public.tasks x
  join public.contracts k on k.company_id = x.company_id and k.id = x.contract_id
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  left join public.products p on p.company_id = k.company_id and p.id = k.product_id
  left join public.projects pj on pj.company_id = x.company_id and pj.id = x.project_id
  where x.id = p_id;
 if not found or t.archived then perform mavi_private.ai_forget('task', p_id); return; end if;
 v_header := concat_ws(' · ', format('[Tarefa] "%s"', t.title), 'cliente ' || t.client_name,
  'produto ' || t.product_name, case when t.project_name is not null then 'projeto ' || t.project_name end,
  'criada em ' || to_char(t.created_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'));
 v_body := concat_ws(E'\n\n', nullif(btrim(mavi_private.rich_plain(t.description)), ''),
  (select string_agg(format('Áudio %s da descrição (transcrição): %s', n, a.transcript), E'\n\n' order by n)
   from (select x.transcript, row_number() over (order by x.position, x.created_at, x.id) as n
     from public.task_audios x where x.company_id = t.company_id and x.task_id = t.id and x.comment_id is null) a
   where a.transcript is not null),
  (select string_agg((f->>'label') || ': ' || (case jsonb_typeof(f->'value') when 'string' then f->>'value'
    else (f->'value')::text end), E'\n')
   from jsonb_array_elements(coalesce(t.custom_fields, '[]')) f
   where f->'value' is not null and jsonb_typeof(f->'value') <> 'null' and (f->>'value') <> ''));
 for piece in select mavi_private.ai_split(coalesce(v_body, '')) loop
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', piece, 'meta', jsonb_build_object('kind', 'task')));
 end loop;
 if jsonb_array_length(v_pieces) = 0 then
  v_pieces := jsonb_build_array(jsonb_build_object('text', t.title, 'meta', jsonb_build_object('kind', 'task')));
 end if;
 select string_agg(format('[%s] %s: %s', to_char(c.created_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'),
   coalesce(m.name, 'Alguém'), concat_ws(' ', nullif(btrim(mavi_private.rich_plain(c.body)), ''),
    (select '(áudio) ' || string_agg(a.transcript, ' ') from public.task_audios a
     where a.comment_id = c.id and a.transcript is not null))), E'\n\n' order by c.created_at)
  into v_comments
  from public.comments c
  left join public.memberships m on m.company_id = c.company_id and m.user_id = c.author_id
  where c.company_id = t.company_id and c.task_id = t.id;
 for piece in select mavi_private.ai_split(coalesce(v_comments, '')) loop
  v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text', 'Comentários:' || E'\n' || piece,
   'meta', jsonb_build_object('kind', 'comments')));
 end loop;
 perform mavi_private.ai_save_document(t.company_id, 'task', t.id, 'task', t.client_id, t.contract_id,
  t.project_id, t.id, t.title, t.created_at, v_header, v_pieces);
end $$;

create function mavi_private.ai_queue_task_audio() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.ai_enqueue('task', (select jsonb_agg(distinct jsonb_build_object('id', task_id, 'company_id', company_id))
  from changed where task_id is not null));
 return null;
end $$;
revoke all on function mavi_private.ai_queue_task_audio() from public, anon, authenticated;
create trigger ai_queue_task_audios_ins after insert on public.task_audios
 referencing new table as changed for each statement execute function mavi_private.ai_queue_task_audio();
create trigger ai_queue_task_audios_upd after update on public.task_audios
 referencing new table as changed for each statement execute function mavi_private.ai_queue_task_audio();
create trigger ai_queue_task_audios_del after delete on public.task_audios
 referencing old table as changed for each statement execute function mavi_private.ai_queue_task_audio();

-- ------------------------------------------------------------ busca
-- A busca das tarefas também acha o que foi dito nos áudios (os da
-- descrição contam como descrição, os dos comentários como comentário).
create or replace function public.search_tasks(
 p_company uuid,
 p_query text default '',
 p_in text[] default array['title', 'description', 'comments'],
 p_client uuid default null,
 p_project uuid default null,
 p_assignee uuid default null,
 p_creator uuid default null,
 p_status text default null,
 p_from date default null,
 p_to date default null,
 p_limit integer default 30,
 p_offset integer default 0)
returns table(
 task_id uuid, title text, status text, due_date date, contract_id uuid,
 project_id uuid, assignee_id uuid, creator_id uuid, created_at timestamptz,
 match_in text, snippet text, comment_id uuid, total bigint)
language sql stable security invoker set search_path = '' as $$
 with q as (
  select mavi_private.fold(trim(coalesce(p_query, ''))) as term),
 pattern as (
  select term, '%' || replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat from q),
 base as (
  select t.* from public.tasks t
  left join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
  where t.company_id = p_company and not t.archived
   and (p_client is null or k.client_id = p_client)
   and (p_project is null or t.project_id = p_project)
   and (p_assignee is null or t.assignee_id = p_assignee)
   and (p_creator is null or t.creator_id = p_creator)
   and (coalesce(p_status, '') = '' or t.status = p_status)
   and (p_from is null or t.due_date >= p_from)
   and (p_to is null or t.due_date <= p_to)),
 hits as (
  -- No text: the filters alone list the tasks.
  select b.id as task_id, 'filters'::text as match_in, ''::text as txt, null::uuid as comment_id, 0 as rank, b.created_at as at
  from base b, pattern p where p.term = ''
  union all
  select b.id, 'title', b.title, null, 1, b.created_at
  from base b, pattern p
  where p.term <> '' and 'title' = any(p_in) and mavi_private.fold(b.title) like p.pat
  union all
  select b.id, 'description', mavi_private.rich_plain(b.description), null, 2, b.created_at
  from base b, pattern p
  where p.term <> '' and 'description' = any(p_in)
   and mavi_private.fold(mavi_private.rich_plain(b.description)) like p.pat
  union all
  select b.id, 'description', a.transcript, null, 2, a.created_at
  from base b join public.task_audios a on a.company_id = b.company_id and a.task_id = b.id and a.comment_id is null,
   pattern p
  where p.term <> '' and 'description' = any(p_in) and a.transcript is not null
   and mavi_private.fold(a.transcript) like p.pat
  union all
  select b.id, 'comment', mavi_private.rich_plain(c.body), c.id, 3, c.created_at
  from base b join public.comments c on c.company_id = b.company_id and c.task_id = b.id, pattern p
  where p.term <> '' and 'comments' = any(p_in)
   and mavi_private.fold(mavi_private.rich_plain(c.body)) like p.pat
  union all
  select b.id, 'comment', a.transcript, a.comment_id, 3, a.created_at
  from base b join public.task_audios a on a.company_id = b.company_id and a.task_id = b.id and a.comment_id is not null,
   pattern p
  where p.term <> '' and 'comments' = any(p_in) and a.transcript is not null
   and mavi_private.fold(a.transcript) like p.pat),
 best as (
  select distinct on (h.task_id) h.* from hits h order by h.task_id, h.rank, h.at desc)
 select b.task_id, t.title, t.status, t.due_date, t.contract_id, t.project_id,
  t.assignee_id, t.creator_id, t.created_at, b.match_in,
  case when b.match_in = 'filters' then '' else mavi_private.search_snippet(b.txt, p.term) end,
  b.comment_id, count(*) over ()
 from best b join public.tasks t on t.id = b.task_id, pattern p
 order by b.rank, t.created_at desc, t.id
 limit least(greatest(coalesce(p_limit, 30), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
$$;

commit;
