// Sends phone alerts (Web Push) to TCSA hub members.
// Two callers:
//   1. The database trigger on new referrals, authenticated with the x-push-secret header.
//   2. A signed-in member asking for a test alert to their own devices.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

let config: Record<string, string> | null = null;
async function getConfig() {
  if (config) return config;
  const { data, error } = await admin.rpc("push_config");
  if (error) throw error;
  config = data as Record<string, string>;
  webpush.setVapidDetails(config.vapid_subject, config.vapid_public, config.vapid_private);
  return config;
}

type Sub = { endpoint: string; p256dh: string; auth: string; user_id: string };

async function sendAll(subs: Sub[], payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  let sent = 0, failed = 0;
  const dead: string[] = [];
  const errors: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body,
        { TTL: 60 * 60 * 12, urgency: "high" });
      sent++;
    } catch (e) {
      failed++;
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) dead.push(s.endpoint);
      errors.push(String(code ?? (e as Error).message).slice(0, 120));
    }
  }));
  if (dead.length) await admin.from("push_subscriptions").delete().in("endpoint", dead);
  return { sent, failed, removed: dead.length, errors: errors.slice(0, 5) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let input: Record<string, string> = {};
  try { input = await req.json(); } catch { /* empty body */ }

  try {
    const cfg = await getConfig();

    // 1. Fan-out from the database trigger.
    if (req.headers.get("x-push-secret")) {
      if (req.headers.get("x-push-secret") !== cfg.push_secret) return json({ error: "Not allowed" }, 403);
      const { data: members, error: mErr } = await admin.from("profiles").select("id").eq("active", true);
      if (mErr) throw mErr;
      const ids = (members ?? []).map((m) => m.id).filter((id) => id !== input.exclude_user);
      if (!ids.length) return json({ sent: 0, failed: 0, removed: 0 });
      const { data: subs, error } = await admin.from("push_subscriptions").select("endpoint,p256dh,auth,user_id").in("user_id", ids);
      if (error) throw error;
      return json(await sendAll(subs ?? [], {
        title: input.title, body: input.body, url: input.url, tag: input.tag,
      }));
    }

    // 2. Test alert for the signed-in member.
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "Sign in first" }, 401);
    const { data: subs, error } = await admin.from("push_subscriptions").select("endpoint,p256dh,auth,user_id").eq("user_id", u.user.id);
    if (error) throw error;
    if (!subs?.length) return json({ error: "Alerts aren't turned on for any of your devices yet." }, 400);
    return json(await sendAll(subs, {
      title: "Alerts are working",
      body: "You'll get one like this when someone in the group logs a referral.",
      url: cfg.app_url, tag: "test",
    }));
  } catch (e) {
    return json({ error: (e as Error).message ?? String(e) }, 500);
  }
});
