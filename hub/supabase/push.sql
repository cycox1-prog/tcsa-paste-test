-- =====================================================================
-- Phone alerts (Web Push). Run after schema.sql.
-- The VAPID private key and push secret are inserted separately, once,
-- and never committed to the repo.
-- =====================================================================

create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_user on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;

drop policy if exists push_read   on public.push_subscriptions;
drop policy if exists push_insert on public.push_subscriptions;
drop policy if exists push_update on public.push_subscriptions;
drop policy if exists push_delete on public.push_subscriptions;
create policy push_read on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy push_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = auth.uid() and public.is_member());
create policy push_update on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy push_delete on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

insert into private.settings(key, value) values
  ('push_function_url', ''),
  ('push_secret', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- Only the alert function (service role) can read the signing keys.
create or replace function public.push_config() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_object_agg(key, value) from private.settings
  where key in ('vapid_public', 'vapid_private', 'vapid_subject', 'push_secret', 'app_url');
$$;
revoke all on function public.push_config() from public, anon, authenticated;
grant execute on function public.push_config() to service_role;

-- Fan out an alert to every member except the person who logged it.
create or replace function private.notify_push() returns trigger
language plpgsql security definer set search_path = public as $$
declare fn text; secret text; app text; referred text; referrer text; who text; link text;
begin
  select value into fn from private.settings where key = 'push_function_url';
  if coalesce(fn, '') = '' then return new; end if;
  select value into secret from private.settings where key = 'push_secret';
  select value into app from private.settings where key = 'app_url';
  select name into referred from businesses where id = new.referred_business_id;
  select name into referrer from businesses where id = new.referrer_business_id;
  select full_name into who from profiles where id = new.created_by;
  link := rtrim(coalesce(app, ''), '/') || '/?r=' || new.id;
  perform net.http_post(
    url := fn,
    body := jsonb_build_object(
      'title', 'New referral: ' || coalesce(referred, 'a TCSA business'),
      'body',  coalesce(who, 'Someone') || ' (' || coalesce(referrer, '') || ') needs backup. Tap to reply.',
      'url', link, 'tag', new.id::text, 'exclude_user', new.created_by::text),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
  );
  return new;
exception when others then
  raise warning 'Push alert failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists notify_push on public.referrals;
create trigger notify_push after insert on public.referrals
  for each row execute function private.notify_push();
