# Supabase Setup Notes

## Public Schema Data API Grants

Supabase is changing public table Data API exposure defaults. Every new table
created in the `public` schema for this project must include all of the
following in the same setup or migration step:

- `alter table ... enable row level security;`
- explicit `grant ... on public.TABLE_NAME ...;`
- RLS policies for every browser-accessible table
- no `anon` or `authenticated` grants for backend-only tables

Backend-only tables are accessed with `SUPABASE_SERVICE_ROLE_KEY` from
`server.cjs` or one-off ingestion scripts. These tables should grant access only
to `service_role`.

Browser-accessed tables must justify the browser role grant and enforce the real
authorization with RLS policies. Currently, only `public.admin_users` is read or
modified directly from the browser after Supabase Auth login.

Apply `schema-grants.sql` after creating the project tables, and keep it updated
whenever a new public table is added.
