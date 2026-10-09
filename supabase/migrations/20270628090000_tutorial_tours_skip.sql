begin;

-- Onboarding: o botão "Pular" dos passos que esperam o clique passa a ser
-- escolhido por passo (skip; ligado se não for dito, como já era). Só a
-- limpeza dos passos muda: ela guarda as chaves conhecidas e agora guarda
-- também esta.

create or replace function mavi_private.tour_steps_clean(p jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare s jsonb; n integer := 0; ids text[] := '{}'; v_id text; v_kind text; v_place text; v_page text; v_url text;
 v_title text; v_body text; v_target jsonb; v_record text; v_real boolean; v_skip boolean; result jsonb := '[]'; begin
 if p is null or jsonb_typeof(p) <> 'array' then return '[]'; end if;
 if jsonb_array_length(p) > 60 then raise exception 'Um onboarding pode ter até 60 passos.' using errcode = '22023'; end if;
 for s in select x from jsonb_array_elements(p) x loop
  n := n + 1;
  if jsonb_typeof(s) <> 'object' then raise exception 'Passo % inválido', n using errcode = '22023'; end if;
  v_id := coalesce(s->>'id', '');
  if v_id !~ '^[a-z0-9]{6,24}$' or v_id = any(ids) then raise exception 'Passo % sem identificador válido', n using errcode = '22023'; end if;
  ids := ids || v_id;
  v_kind := coalesce(s->>'kind', 'next');
  if v_kind not in ('next', 'click', 'input', 'auto') then raise exception 'Tipo do passo % inválido', n using errcode = '22023'; end if;
  v_place := coalesce(s->>'placement', 'auto');
  if v_place not in ('auto', 'top', 'bottom', 'left', 'right') then v_place := 'auto'; end if;
  v_page := coalesce(s->>'page', '');
  if v_page !~ '^[a-zA-Z]{2,40}$' then raise exception 'O passo % não tem a tela onde aparece.', n using errcode = '22023'; end if;
  v_url := coalesce(s->>'url', '');
  if v_url !~ '^/' or v_url ~ '^//' or v_url ~ '[\\\r\n]' or length(v_url) > 600 then
   raise exception 'Endereço do passo % inválido', n using errcode = '22023';
  end if;
  v_title := regexp_replace(btrim(coalesce(s->>'title', '')), '\s+', ' ', 'g');
  if length(v_title) > 120 then raise exception 'O título do passo % pode ter até 120 caracteres.', n using errcode = '22023'; end if;
  v_body := coalesce(s->>'body', '');
  if length(v_body) > 60000 then raise exception 'O texto do passo % está grande demais.', n using errcode = '22023'; end if;
  v_target := s->'target';
  if v_target is not null and jsonb_typeof(v_target) = 'null' then v_target := null; end if;
  if v_target is not null and (jsonb_typeof(v_target) <> 'object' or length(v_target::text) > 8000) then
   raise exception 'Elemento do passo % inválido', n using errcode = '22023';
  end if;
  if v_target is null and v_kind <> 'next' then
   raise exception 'O passo % precisa de um elemento na tela para esse tipo.', n using errcode = '22023';
  end if;
  if v_title = '' and mavi_private.rich_plain(v_body) ~ '^\s*$' and v_kind <> 'auto' then
   raise exception 'Escreva o texto do balão do passo %.', n using errcode = '22023';
  end if;
  v_record := case when s->>'record' = 'same' then 'same' else 'any' end;
  -- Só um clique esperado pode ficar "só mostrado"; o tour que clica, clica.
  v_real := case when v_kind = 'click' then coalesce((s->>'real')::boolean, true) else true end;
  -- O botão "Pular" do passo que espera o clique (ligado, se não disserem).
  v_skip := case when v_kind = 'click' then coalesce((s->>'skip')::boolean, true) else true end;
  result := result || jsonb_build_array(jsonb_build_object('id', v_id, 'kind', v_kind, 'placement', v_place,
   'page', v_page, 'url', v_url, 'title', v_title, 'body', v_body, 'target', v_target, 'record', v_record,
   'real', v_real, 'skip', v_skip));
 end loop;
 return result;
end $$;

commit;
