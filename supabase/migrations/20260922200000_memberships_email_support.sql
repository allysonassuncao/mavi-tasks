-- Add email support to public.memberships for administrative visibility and user management
alter table public.memberships add column if not exists email text not null default '';

-- Backfill emails from auth.users where available
update public.memberships m
set email = lower(trim(u.email))
from auth.users u
where m.user_id = u.id and (m.email is null or m.email = '') and u.email is not null;

-- Helpful index for lookups by email within a company
create index if not exists memberships_company_email_idx on public.memberships(company_id, lower(email));
