-- =====================================================================
-- TCSA Referral Hub — database setup
-- Run once in a new Supabase project (SQL editor or migration).
-- Safe to re-run: objects are created only if missing, policies replaced.
-- =====================================================================

create extension if not exists pg_net with schema extensions;
create schema if not exists private;   -- not exposed through the API

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists public.businesses (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  category     text,                      -- e.g. "Pressure washing"
  artwork_path text,                      -- object path in the 'artwork' bucket
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists public.blurbs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  body        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists blurbs_business on public.blurbs(business_id);

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  business_id uuid not null references public.businesses(id),
  is_admin    boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.referrals (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  created_by           uuid not null references public.profiles(id),
  referrer_business_id uuid not null references public.businesses(id),
  referred_business_id uuid not null references public.businesses(id),
  post_url             text not null,
  note                 text
);
-- The same post can ask for two trades, so uniqueness is per post + business.
create unique index if not exists referrals_post_business
  on public.referrals (lower(post_url), referred_business_id);
create index if not exists referrals_created on public.referrals(created_at desc);

create table if not exists public.backups (
  referral_id uuid not null references public.referrals(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  business_id uuid not null references public.businesses(id),
  blurb_id    uuid references public.blurbs(id) on delete set null,
  done_at     timestamptz not null default now(),
  primary key (referral_id, user_id)
);

create table if not exists private.settings (
  key   text primary key,
  value text
);
insert into private.settings(key, value) values
  ('join_code', 'TCSA' || lpad((floor(random() * 10000))::int::text, 4, '0')),
  ('app_url', ''),
  ('slack_webhook_url', '')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and is_admin);
$$;

-- Fill in who/which business on insert, so the app can't spoof them.
create or replace function private.stamp_referral() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by := auth.uid();
  select business_id into new.referrer_business_id from profiles where id = auth.uid();
  new.post_url := btrim(new.post_url);
  return new;
end $$;

create or replace function private.stamp_backup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();
  select business_id into new.business_id from profiles where id = auth.uid();
  return new;
end $$;

drop trigger if exists stamp_referral on public.referrals;
create trigger stamp_referral before insert on public.referrals
  for each row execute function private.stamp_referral();

drop trigger if exists stamp_backup on public.backups;
create trigger stamp_backup before insert or update on public.backups
  for each row execute function private.stamp_backup();

-- The person who logs a referral already replied on the post.
create or replace function private.auto_backup_creator() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into backups(referral_id, user_id, business_id)
  values (new.id, new.created_by, new.referrer_business_id)
  on conflict do nothing;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Slack notice (skipped quietly until a webhook URL is set)
-- ---------------------------------------------------------------------
create or replace function private.slack_escape(t text) returns text
language sql immutable as $$
  select replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
$$;

create or replace function private.notify_slack() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  hook text; app text; referred text; referrer text; who text; msg text; card text;
begin
  select value into hook from private.settings where key = 'slack_webhook_url';
  if coalesce(hook, '') = '' then return new; end if;
  select value into app from private.settings where key = 'app_url';
  select name into referred from businesses where id = new.referred_business_id;
  select name into referrer from businesses where id = new.referrer_business_id;
  select full_name into who from profiles where id = new.created_by;

  card := case when coalesce(app, '') = '' then null
               else rtrim(app, '/') || '/?r=' || new.id end;
  msg := ':mega: *New referral: ' || private.slack_escape(referred) || '*' || chr(10)
      || 'Referred by ' || private.slack_escape(who) || ' (' || private.slack_escape(referrer) || ')' || chr(10)
      || coalesce('<' || card || '|Open referral card>  ·  ', '')
      || '<' || new.post_url || '|Facebook post>';

  perform net.http_post(
    url  := hook,
    body := jsonb_build_object('text', msg),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  return new;
exception when others then
  -- Never block a referral because Slack failed.
  raise warning 'Slack notice failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists after_referral on public.referrals;
create trigger after_referral after insert on public.referrals
  for each row execute function private.auto_backup_creator();

drop trigger if exists notify_slack on public.referrals;
create trigger notify_slack after insert on public.referrals
  for each row execute function private.notify_slack();

-- ---------------------------------------------------------------------
-- RPCs the app calls
-- ---------------------------------------------------------------------
-- Join the group with the group code. The first person to join becomes admin.
create or replace function public.join_group(p_code text, p_name text, p_business uuid)
returns void language plpgsql security definer set search_path = public as $$
declare expected text; first boolean;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select value into expected from private.settings where key = 'join_code';
  if upper(btrim(coalesce(p_code, ''))) <> upper(expected) then
    raise exception 'That group code is not right. Ask your TCSA admin for the current code.';
  end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Enter your name'; end if;
  if not exists (select 1 from businesses where id = p_business and active) then
    raise exception 'Pick your business';
  end if;
  select not exists (select 1 from profiles) into first;
  insert into profiles(id, full_name, business_id, is_admin)
  values (auth.uid(), btrim(p_name), p_business, first)
  on conflict (id) do update set full_name = excluded.full_name, business_id = excluded.business_id;
end $$;

-- Lets the app know whether to offer a "copy Slack message" fallback.
create or replace function public.slack_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member()
     and coalesce((select value from private.settings where key = 'slack_webhook_url'), '') <> '';
$$;

create or replace function public.get_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'join_code', (select value from private.settings where key = 'join_code'),
    'app_url',   (select value from private.settings where key = 'app_url'),
    'slack_set', coalesce((select value from private.settings where key = 'slack_webhook_url'), '') <> ''
  );
end $$;

create or replace function public.set_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_key not in ('join_code', 'app_url', 'slack_webhook_url') then
    raise exception 'Unknown setting %', p_key;
  end if;
  if p_key = 'slack_webhook_url' and coalesce(p_value, '') <> ''
     and p_value not like 'https://hooks.slack.com/%' then
    raise exception 'A Slack webhook URL starts with https://hooks.slack.com/';
  end if;
  update private.settings set value = btrim(coalesce(p_value, '')) where key = p_key;
end $$;

revoke all on function public.join_group(text, text, uuid) from public, anon;
revoke all on function public.get_settings() from public, anon;
revoke all on function public.set_setting(text, text) from public, anon;
revoke all on function public.slack_enabled() from public, anon;
grant execute on function public.join_group(text, text, uuid) to authenticated;
grant execute on function public.get_settings() to authenticated;
grant execute on function public.set_setting(text, text) to authenticated;
grant execute on function public.slack_enabled() to authenticated;

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------
alter table public.businesses enable row level security;
alter table public.blurbs     enable row level security;
alter table public.profiles   enable row level security;
alter table public.referrals  enable row level security;
alter table public.backups    enable row level security;

-- Businesses: any signed-in user can read (needed on the join screen).
drop policy if exists businesses_read  on public.businesses;
drop policy if exists businesses_admin on public.businesses;
create policy businesses_read  on public.businesses for select to authenticated using (true);
create policy businesses_admin on public.businesses for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists blurbs_read  on public.blurbs;
drop policy if exists blurbs_admin on public.blurbs;
create policy blurbs_read  on public.blurbs for select to authenticated using (public.is_member());
create policy blurbs_admin on public.blurbs for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists profiles_read  on public.profiles;
drop policy if exists profiles_admin on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_member());
create policy profiles_admin on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists referrals_read   on public.referrals;
drop policy if exists referrals_insert on public.referrals;
drop policy if exists referrals_delete on public.referrals;
create policy referrals_read   on public.referrals for select to authenticated using (public.is_member());
create policy referrals_insert on public.referrals for insert to authenticated with check (public.is_member());
create policy referrals_delete on public.referrals for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

drop policy if exists backups_read   on public.backups;
drop policy if exists backups_insert on public.backups;
drop policy if exists backups_delete on public.backups;
drop policy if exists backups_update on public.backups;
create policy backups_update on public.backups for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy backups_read   on public.backups for select to authenticated using (public.is_member());
create policy backups_insert on public.backups for insert to authenticated with check (public.is_member());
create policy backups_delete on public.backups for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------
-- Artwork storage: public to read, admins upload
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('artwork', 'artwork', true)
on conflict (id) do nothing;

drop policy if exists artwork_admin_select on storage.objects;
create policy artwork_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'artwork' and public.is_admin());
drop policy if exists artwork_admin_insert on storage.objects;
drop policy if exists artwork_admin_update on storage.objects;
drop policy if exists artwork_admin_delete on storage.objects;
create policy artwork_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'artwork' and public.is_admin());
create policy artwork_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'artwork' and public.is_admin());
create policy artwork_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'artwork' and public.is_admin());
