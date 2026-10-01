-- Drive › cliente › Whatsapp: a varredura dos grupos na Uazapi passa de 2 em 2
-- horas para 1 em 1 hora (mavi_private.whatsapp_kick já lê sweep_hours).
begin;
alter table mavi_private.whatsapp_config alter column sweep_hours set default 1;
update mavi_private.whatsapp_config set sweep_hours = 1 where sweep_hours <> 1;
commit;
