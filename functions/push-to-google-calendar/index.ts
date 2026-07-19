// Supabase Edge Function: push-to-google-calendar
//
// Called by the client after every save(). One-way (Phase 1): pushes this
// app's schedules/tasks to the user's connected Google Calendar. Does NOT
// write to app_state itself - it returns which series got a new/changed
// googleEventId, and the client merges that into its own state and saves
// normally. (Writing here directly would race with the client's own save()
// and get clobbered, since save() always overwrites the whole series array.)
//
// Sync scope for Phase 1:
//  - schedules: full support, including recurrence (converted to RRULE)
//  - tasks: only non-recurring tasks with a due date (single all-day event
//    on that date). Recurring tasks aren't synced yet - the "due date is an
//    offset from each occurrence" model doesn't map cleanly onto a single
//    RRULE event; revisit in Phase 2.
//
// Deploy via the Supabase Dashboard (Edge Functions > Deploy a new function
// > Via Editor). Requires secrets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.

import { createClient } from 'npm:@supabase/supabase-js@2';

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// The browser's supabase-js client sends a CORS preflight (OPTIONS) before
// the real POST. Without these headers - and without short-circuiting
// OPTIONS before the auth check - that preflight itself gets treated as an
// unauthenticated request and 401s, which fails the whole call before the
// real request is ever sent.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const WD_ICAL = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function toRRule(recurrence: any, until: string | null): string | null {
  if (!recurrence || recurrence.type === 'none') return null;
  const untilPart = until ? `;UNTIL=${until.replace(/-/g, '')}T000000Z` : '';
  switch (recurrence.type) {
    case 'weekly': return `RRULE:FREQ=WEEKLY${untilPart}`;
    case 'monthly': return `RRULE:FREQ=MONTHLY${untilPart}`;
    case 'monthlyNth': {
      const nth = recurrence.nth === 5 ? -1 : recurrence.nth;
      return `RRULE:FREQ=MONTHLY;BYDAY=${nth}${WD_ICAL[recurrence.weekday]}${untilPart}`;
    }
    case 'monthStart': return `RRULE:FREQ=MONTHLY;BYMONTHDAY=1${untilPart}`;
    case 'monthEnd': return `RRULE:FREQ=MONTHLY;BYMONTHDAY=-1${untilPart}`;
    case 'yearly': return `RRULE:FREQ=YEARLY${untilPart}`;
    default: return null;
  }
}

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('token refresh failed: ' + await res.text());
  return (await res.json()).access_token;
}

async function gcal(accessToken: string, calendarId: string, method: string, path: string, body?: unknown) {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }
  );
  if (res.status === 404 || res.status === 410) return null; // event gone on Google's side
  if (res.status === 204) return {};
  if (!res.ok) throw new Error(`Google Calendar ${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  try {
    // explicit deletions (a series that was removed from state.series
    // entirely, so this is the only place its googleEventId still exists)
    let deleteEventIds: string[] = [];
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        if (Array.isArray(body?.deleteEventIds)) deleteEventIds = body.deleteEventIds;
      } catch { /* no/empty body is fine - just a regular sync push */ }
    }

    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: { user }, error: userErr } = await sb.auth.getUser(jwt);
    if (userErr || !user) return new Response('unauthorized', { status: 401, headers: CORS_HEADERS });

    const { data: account } = await sb
      .from('google_calendar_accounts')
      .select('refresh_token, calendar_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (!account) {
      return new Response(JSON.stringify({ connected: false }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const { data: appState } = await sb.from('app_state').select('data').eq('user_id', user.id).maybeSingle();
    const series: any[] = (appState?.data?.series) || [];

    const accessToken = await refreshAccessToken(account.refresh_token);
    const calendarId = account.calendar_id || 'primary';

    if (deleteEventIds.length) {
      // explicit delete-only call: the client fires this immediately when a
      // series is removed, separately from (and before) its own save()
      // persists that removal. app_state here may still list the deleted
      // series, so don't run the full sync below - it would just recreate
      // what we're deleting. The client's regular save() triggers its own
      // ordinary push afterwards once the removal is actually persisted.
      for (const eventId of deleteEventIds) {
        await gcal(accessToken, calendarId, 'DELETE', `/events/${eventId}`);
      }
      return new Response(JSON.stringify({ connected: true, updates: [] }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const updates: { id: string; googleEventId: string | null }[] = [];

    for (const s of series) {
      const isSchedule = s.kind === 'schedule';
      const shouldSync = isSchedule || (!!s.dueDate && (!s.recurrence || s.recurrence.type === 'none'));

      if (!shouldSync) {
        if (s.googleEventId) {
          await gcal(accessToken, calendarId, 'DELETE', `/events/${s.googleEventId}`);
          updates.push({ id: s.id, googleEventId: null });
        }
        continue;
      }

      let startDate: string, endDateExclusive: string, recurrence: string | null;
      if (isSchedule) {
        startDate = s.startDate;
        endDateExclusive = addDaysStr(s.startDate, (s.endOffsetDays || 0) + 1);
        recurrence = toRRule(s.recurrence, s.until);
      } else {
        startDate = s.dueDate;
        endDateExclusive = addDaysStr(s.dueDate, 1);
        recurrence = null;
      }

      const eventBody = {
        summary: s.name,
        description: s.memo || '',
        start: { date: startDate },
        end: { date: endDateExclusive },
        recurrence: recurrence ? [recurrence] : undefined,
      };

      if (s.googleEventId) {
        const updated = await gcal(accessToken, calendarId, 'PATCH', `/events/${s.googleEventId}`, eventBody);
        if (!updated) {
          const created = await gcal(accessToken, calendarId, 'POST', '/events', eventBody);
          updates.push({ id: s.id, googleEventId: created.id });
        }
      } else {
        const created = await gcal(accessToken, calendarId, 'POST', '/events', eventBody);
        updates.push({ id: s.id, googleEventId: created.id });
      }
    }

    return new Response(JSON.stringify({ connected: true, updates }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
