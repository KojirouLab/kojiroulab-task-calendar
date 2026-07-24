// ここに Supabase の Project URL と anon key を貼り付けてください。
// (Supabase ダッシュボード > Project Settings > API で確認できます。anon key は
// 公開されても問題ない設計です。アクセス制御はサーバー側の RLS ポリシーで行っています。)
const SUPABASE_URL = 'https://ylvvjqwbhfggwjivkgvr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Qjz-ym0gL42g3Hbv8tx8qQ_ylLEt3B_';

let sb = null;
try {
  // flowType 'implicit': the default 'pkce' flow requires the browser that
  // requested the magic link to be the same one that opens it (it needs a
  // locally-stored code verifier). Email links are routinely opened in a
  // different app/browser (Gmail's in-app browser, a different Safari tab,
  // the installed home-screen app), so PKCE silently fails there. Implicit
  // flow puts the session directly in the link, so any browser can use it.
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { flowType: 'implicit' },
  });
} catch (e) {
  console.error('Supabase client init failed', e);
}

let state = { series: [], inbox: [] };
let loaded = false;

async function load() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  async function attempt() {
    const { data, error } = await sb
      .from('app_state')
      .select('data')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) throw error;
    const raw = data ? data.data : null;
    if (Array.isArray(raw)) return { series: raw, inbox: [] };
    if (raw) return { series: raw.series || [], inbox: raw.inbox || [] };
    return { series: [], inbox: [] };
  }

  let result;
  try {
    result = await attempt();
  } catch (e) {
    try {
      result = await attempt();
    } catch (e2) {
      result = { series: [], inbox: [] };
    }
  }
  state.series = result.series;
  state.inbox = result.inbox;
  state.series.forEach((s, i) => { if (typeof s.order !== 'number') s.order = i; });
  loaded = true;
  render();
  checkGoogleConnected();
}

let pendingSavePayload = null;
let saveDebounceTimer = null;
function save() {
  pendingSavePayload = { series: state.series, inbox: state.inbox };
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(flushSave, 600);
}
async function flushSave() {
  saveDebounceTimer = null;
  if (!pendingSavePayload) return;
  const payload = pendingSavePayload;
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { showSaveError(); return; }
    const { error } = await sb.from('app_state').upsert({
      user_id: user.id,
      data: payload,
      updated_at: new Date().toISOString(),
    });
    if (!error) { pendingSavePayload = null; hideSaveError(); pushToGoogleCalendar(); }
    else { showSaveError(); }
  } catch (e) {
    console.error('save failed', e);
    showSaveError();
  }
}

// ---- Google Calendar sync (Phase 1: push only, this app -> Google) ----
const GOOGLE_CLIENT_ID = '647666710506-ei4vdt815losatj0sl3r22k1b4bmth7d.apps.googleusercontent.com';
let googleConnected = false;

async function checkGoogleConnected() {
  if (!sb) return;
  const { data } = await sb.from('google_calendar_accounts').select('user_id').maybeSingle();
  googleConnected = !!data;
}

async function connectGoogleCalendar() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  const redirectUri = `${SUPABASE_URL}/functions/v1/google-oauth-callback`;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent', // force a fresh consent every time so Google always returns a refresh_token
    state: session.access_token,
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function disconnectGoogleCalendar() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  await sb.from('google_calendar_accounts').delete().eq('user_id', user.id);
  googleConnected = false;
}

// Deleting a series removes it from state.series entirely, so its
// googleEventId is gone by the time the next regular push runs - the sync
// loop only ever looks at what's currently in the list, it has no memory of
// what used to be there. Report the deletion explicitly, right away, while
// we still have the id.
async function deleteGoogleCalendarEvent(googleEventId) {
  if (!googleConnected || !sb || !googleEventId) return;
  try {
    await sb.functions.invoke('push-to-google-calendar', { body: { deleteEventIds: [googleEventId] } });
  } catch (e) {
    console.error('google calendar delete failed', e);
  }
}

// flushSave() fires pushToGoogleCalendar() after every save, and pushes can
// take a couple seconds (token refresh + several Google API calls). Without
// this guard, saving again while a push is still in flight starts a second,
// overlapping push that reads the same not-yet-updated googleEventId state
// from the server and creates a duplicate event instead of updating the
// existing one. Coalesce concurrent calls into a single follow-up run.
let googlePushInFlight = false;
let googlePushQueued = false;
async function pushToGoogleCalendar() {
  if (!googleConnected || !sb) return;
  if (googlePushInFlight) { googlePushQueued = true; return; }
  googlePushInFlight = true;
  try {
    const { data, error } = await sb.functions.invoke('push-to-google-calendar');
    if (!error && data && data.updates) {
      let changed = false;
      data.updates.forEach(u => {
        const series = state.series.find(s => s.id === u.id);
        if (!series) return;
        if (u.googleEventId) series.googleEventId = u.googleEventId;
        else delete series.googleEventId;
        changed = true;
      });
      if (changed) save();
    }
  } catch (e) {
    console.error('google calendar push failed', e);
  } finally {
    googlePushInFlight = false;
    if (googlePushQueued) {
      googlePushQueued = false;
      pushToGoogleCalendar();
    }
  }
}

// handle the redirect back from google-oauth-callback (?google=connected|error)
(function handleGoogleAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('google');
  if (!status) return;
  const detail = params.get('detail');
  history.replaceState(null, '', window.location.pathname);
  setTimeout(() => {
    if (status === 'connected') {
      googleConnected = true;
      alert('Googleカレンダーと連携しました。');
      pushToGoogleCalendar();
    } else {
      alert('Googleカレンダー連携に失敗しました' + (detail ? `（${detail}）` : ''));
    }
  }, 300);
})();
function showSaveError() {
  const el = document.getElementById('saveError'); if (!el) return;
  el.querySelector('.msg').textContent = '保存に失敗しました（通信エラー）。';
  el.querySelector('#retrySaveBtn').style.display = '';
  el.style.display = 'flex';
}
function hideSaveError() { const el = document.getElementById('saveError'); if (el) el.style.display = 'none'; }

// 開いた時（フォアグラウンド復帰時）に最新データを取り直す。
// 未保存の編集がある間は上書きしないようにガードする。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && loaded && !pendingSavePayload) {
    load();
  }
});

// ---- auth gate ----
// Uses the emailed 6-digit code (verifyOtp) rather than the clicked magic
// link: tapping the link routinely opens in a different browser/app context
// (Gmail's in-app browser, Safari vs. the installed home-screen app) than
// where the session needs to end up, so it silently never completes there.
// Typing the code into whichever context is currently open sidesteps that
// entirely.
const authGate = document.getElementById('authGate');
const authEmailInput = document.getElementById('authEmailInput');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const authMsg = document.getElementById('authMsg');
const authCodeRow = document.getElementById('authCodeRow');
const authCodeInput = document.getElementById('authCodeInput');
const authVerifyBtn = document.getElementById('authVerifyBtn');

function showAuthGate(msg) {
  authGate.style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  if (msg) authMsg.textContent = msg;
}
function hideAuthGate() {
  authGate.style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

authSubmitBtn.addEventListener('click', async () => {
  if (!sb) return;
  const email = authEmailInput.value.trim();
  if (!email) return;
  authSubmitBtn.disabled = true;
  authMsg.textContent = '送信中…';
  const { error } = await sb.auth.signInWithOtp({ email });
  authSubmitBtn.disabled = false;
  if (error) {
    authMsg.textContent = `送信に失敗しました: ${error.message}`;
    return;
  }
  authMsg.textContent = `${email} 宛に6桁の確認コードを送りました。メールを確認して下に入力してください。`;
  authCodeRow.style.display = 'block';
  authCodeInput.focus();
});

authVerifyBtn.addEventListener('click', async () => {
  if (!sb) return;
  const email = authEmailInput.value.trim();
  const token = authCodeInput.value.trim();
  if (!email || !token) return;
  authVerifyBtn.disabled = true;
  authMsg.textContent = '確認中…';
  const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
  authVerifyBtn.disabled = false;
  if (error) {
    authMsg.textContent = `確認に失敗しました: ${error.message}`;
  }
  // success falls through to onAuthStateChange, which hides the gate.
});

if (sb) {
  sb.auth.onAuthStateChange((_event, session) => {
    if (session && session.user) {
      hideAuthGate();
      load();
    } else {
      showAuthGate('');
    }
  });
}

async function initApp() {
  if (!sb) {
    authEmailInput.style.display = 'none';
    authSubmitBtn.style.display = 'none';
    showAuthGate('セットアップ未完了です。storage.js の SUPABASE_URL と SUPABASE_ANON_KEY を、あなたのSupabaseプロジェクトの値に書き換えてください（SETUP.md 参照）。');
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session && session.user) {
    hideAuthGate();
    load();
  } else {
    showAuthGate('続けるにはメールアドレスを入力してください。');
  }
}
