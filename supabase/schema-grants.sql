-- Supabase public schema Data API grants for TBS Live Translation.
-- Run after creating the listed tables.
-- Rule: every new public table must have explicit GRANT + RLS + policies where needed.

grant usage on schema public to service_role;
grant usage on schema public to authenticated;

-- Backend-only tables.
-- These are accessed by server.cjs and ingestion scripts using SUPABASE_SERVICE_ROLE_KEY.
-- Do not grant anon/authenticated access.
alter table public.live_sessions enable row level security;
alter table public.session_lines enable row level security;
alter table public.session_brain_state enable row level security;
alter table public.tbs_sources enable row level security;
alter table public.tbs_knowledge_chunks enable row level security;

grant select, insert, update, delete on public.live_sessions to service_role;
grant select, insert, update, delete on public.session_lines to service_role;
grant select, insert, update, delete on public.session_brain_state to service_role;
grant select, insert, update, delete on public.tbs_sources to service_role;
grant select, insert, update, delete on public.tbs_knowledge_chunks to service_role;

-- Browser-accessed admin table.
-- App.jsx reads this table after Supabase Auth login and Super Admins manage users from the browser.
-- No anon grant: viewer/public areas must not access this table directly.
alter table public.admin_users enable row level security;

grant select, insert, update, delete on public.admin_users to service_role;
grant select, insert, update on public.admin_users to authenticated;

drop policy if exists "admin users can read own row" on public.admin_users;
create policy "admin users can read own row"
on public.admin_users
for select
to authenticated
using (lower(email) = lower((auth.jwt() ->> 'email')));

drop policy if exists "active super admins can read admin users" on public.admin_users;
create policy "active super admins can read admin users"
on public.admin_users
for select
to authenticated
using (
  exists (
    select 1
    from public.admin_users current_admin
    where lower(current_admin.email) = lower((auth.jwt() ->> 'email'))
      and current_admin.role = 'super_admin'
      and current_admin.status = 'active'
  )
);

drop policy if exists "active super admins can insert admin users" on public.admin_users;
create policy "active super admins can insert admin users"
on public.admin_users
for insert
to authenticated
with check (
  exists (
    select 1
    from public.admin_users current_admin
    where lower(current_admin.email) = lower((auth.jwt() ->> 'email'))
      and current_admin.role = 'super_admin'
      and current_admin.status = 'active'
  )
);

drop policy if exists "active super admins can update admin users" on public.admin_users;
create policy "active super admins can update admin users"
on public.admin_users
for update
to authenticated
using (
  exists (
    select 1
    from public.admin_users current_admin
    where lower(current_admin.email) = lower((auth.jwt() ->> 'email'))
      and current_admin.role = 'super_admin'
      and current_admin.status = 'active'
  )
)
with check (
  exists (
    select 1
    from public.admin_users current_admin
    where lower(current_admin.email) = lower((auth.jwt() ->> 'email'))
      and current_admin.role = 'super_admin'
      and current_admin.status = 'active'
  )
);
