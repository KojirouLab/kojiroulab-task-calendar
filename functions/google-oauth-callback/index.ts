// Supabase Edge Function: google-oauth-callback
//
// Google redirects here after the user approves calendar access. `state`
// carries the user's Supabase access token (set by the client when it built
// the authorization URL) so this handler can verify who's actually
// authenticating without any prior session context of its own - Google's
// redirect is a plain unauthenticated GET request.
//
// Deploy via the Supabase Dashboard (Edge Functions > Deploy a new function
// > Via Editor). Requires secrets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
// (Edge Functions > Secrets). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
// injected automatically.

import { createClient } from 'npm:@supabase/supabase-js@2';

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// where to send the user back to when this is done
const APP_URL = 'https://kojiroulab.github.io/kojiroulab-task-calendar/';

function redirectTo(status: 'connected' | 'error', detail?: string) {
  const url = new URL(APP_URL);
  url.searchParams.set('google', status);
  if (detail) url.searchParams.set('detail', detail);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return redirectTo('error', error);
  if (!code || !state) return redirectTo('error', 'missing_code_or_state');

  try {
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: { user }, error: userErr } = await sb.auth.getUser(state);
    if (userErr || !user) return redirectTo('error', 'invalid_state');

    const redirectUri = `${SUPABASE_URL}/functions/v1/google-oauth-callback`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      console.error('token exchange failed', await tokenRes.text());
      return redirectTo('error', 'token_exchange_failed');
    }
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      // happens if the user had already granted access before without a
      // fresh consent prompt - the client always requests prompt=consent
      // precisely to avoid this, but guard anyway.
      return redirectTo('error', 'no_refresh_token');
    }

    const { error: upsertErr } = await sb.from('google_calendar_accounts').upsert({
      user_id: user.id,
      refresh_token: tokens.refresh_token,
      calendar_id: 'primary',
      connected_at: new Date().toISOString(),
    });
    if (upsertErr) {
      console.error('upsert failed', upsertErr);
      return redirectTo('error', 'save_failed');
    }

    return redirectTo('connected');
  } catch (e) {
    console.error(e);
    return redirectTo('error', 'unexpected');
  }
});
