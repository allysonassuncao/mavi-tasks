begin;

-- MAVI · Vários celulares por pessoa.
--
-- Até aqui cada pessoa tinha um celular só (Meu perfil e Membros). Agora são
-- até 10, na ordem em que a pessoa deixou. Todos contam como do time nos
-- grupos de WhatsApp dos clientes (mavi_private.team_phone_keys já lê todas
-- as linhas). O mesmo número digitado duas vezes (com ou sem o nono dígito,
-- com ou sem o 55) fica uma vez só.
--
-- member_phone / set_member_phone dão lugar a member_phones /
-- set_member_phones, que leem e gravam a lista inteira.

alter table mavi_private.user_phones drop constraint user_phones_pkey;
alter table mavi_private.user_phones add column position smallint not null default 0;
alter table mavi_private.user_phones add primary key (user_id, key);

drop function public.member_phone(uuid, uuid);
drop function public.set_member_phone(uuid, uuid, text);

-- A própria pessoa ou um líder da empresa.
create function public.member_phones(p_company uuid, p_user uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) or not (p_user = auth.uid() or mavi_private.leader(p_company))
  or not exists (select 1 from public.memberships where company_id = p_company and user_id = p_user) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return coalesce((select array_agg(phone order by position) from mavi_private.user_phones where user_id = p_user), '{}');
end $$;

-- Grava a lista inteira: o que não veio sai. Lista vazia apaga todos.
create function public.set_member_phones(p_company uuid, p_user uuid, p_phones text[]) returns text[]
language plpgsql security definer set search_path = '' as $$
declare target public.memberships; v_raw text; v_digits text; v_key text;
 v_phones text[] := '{}'; v_keys text[] := '{}'; v_old text[]; v_changed text[]; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into target from public.memberships where company_id = p_company and user_id = p_user;
 if not found then raise exception 'Usuário não encontrado na empresa' using errcode = 'P0002'; end if;
 if p_user <> auth.uid() then
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if target.role = 'admin' and not mavi_private.admin(p_company) then
   raise exception 'Somente administradores editam administradores.' using errcode = '42501';
  end if;
 end if;
 foreach v_raw in array coalesce(p_phones, '{}') loop
  v_digits := regexp_replace(coalesce(v_raw, ''), '\D', '', 'g');
  continue when v_digits = '';
  if length(v_digits) in (10, 11) then v_digits := '55' || v_digits; end if;
  if length(v_digits) not between 12 and 15 then
   raise exception 'Informe o telefone % com DDD (e o código do país, se não for do Brasil).', btrim(v_raw)
    using errcode = '22023';
  end if;
  v_key := mavi_private.phone_key(v_digits);
  continue when v_key = any(v_keys);
  v_phones := v_phones || v_digits;
  v_keys := v_keys || v_key;
 end loop;
 if cardinality(v_phones) > 10 then
  raise exception 'Informe no máximo 10 telefones por pessoa.' using errcode = '22023';
 end if;
 select coalesce(array_agg(key), '{}') into v_old from mavi_private.user_phones where user_id = p_user;
 delete from mavi_private.user_phones where user_id = p_user;
 insert into mavi_private.user_phones(user_id, phone, key, position, updated_by)
 select p_user, p.phone, v_keys[p.n], p.n - 1, auth.uid() from unnest(v_phones) with ordinality as p(phone, n);
 -- As conversas em que um número que entrou ou saiu falou são lidas de novo
 -- (quem é time mudou). Os números que ficaram não mexem em nada.
 select coalesce(array_agg(k), '{}') into v_changed from (
  (select unnest(v_old) except select unnest(v_keys))
  union (select unnest(v_keys) except select unnest(v_old))
 ) x(k);
 if cardinality(v_changed) > 0 then
  update public.temperature_signals s set status = 'pending', dirty_at = now() - interval '1 hour', attempts = 0
  from mavi_private.whatsapp_ai_days d, public.memberships m
  where m.user_id = p_user and s.company_id = m.company_id and s.source_type = 'whatsapp' and s.source_id = d.id
   and s.status in ('done', 'skipped', 'failed')
   and exists (select 1 from public.whatsapp_messages w where w.company_id = d.company_id and w.group_id = d.group_id
    and w.sent_at >= d.day::timestamp at time zone 'America/Sao_Paulo'
    and w.sent_at < (d.day + 1)::timestamp at time zone 'America/Sao_Paulo'
    and mavi_private.phone_key(w.sender_phone) = any(v_changed));
 end if;
 return v_phones;
end $$;

revoke all on function public.member_phones(uuid, uuid), public.set_member_phones(uuid, uuid, text[]) from public, anon;
grant execute on function public.member_phones(uuid, uuid), public.set_member_phones(uuid, uuid, text[]) to authenticated;

commit;
