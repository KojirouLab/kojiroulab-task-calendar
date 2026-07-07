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

let state = { series: [], weeklyMemos: {} };
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
    if (Array.isArray(raw)) return { series: raw, weeklyMemos: {} };
    if (raw) return { series: raw.series || [], weeklyMemos: raw.weeklyMemos || {} };
    return { series: [], weeklyMemos: {} };
  }

  let result;
  try {
    result = await attempt();
  } catch (e) {
    try {
      result = await attempt();
    } catch (e2) {
      result = { series: [], weeklyMemos: {} };
    }
  }
  state.series = result.series;
  state.weeklyMemos = result.weeklyMemos;
  state.series.forEach((s, i) => { if (typeof s.order !== 'number') s.order = i; });
  loaded = true;
  render();
}

let pendingSavePayload = null;
let saveDebounceTimer = null;
function save() {
  pendingSavePayload = { series: state.series, weeklyMemos: state.weeklyMemos };
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
    if (!error) { pendingSavePayload = null; hideSaveError(); }
    else { showSaveError(); }
  } catch (e) {
    console.error('save failed', e);
    showSaveError();
  }
}
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
const authGate = document.getElementById('authGate');
const authEmailInput = document.getElementById('authEmailInput');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const authMsg = document.getElementById('authMsg');

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
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href },
  });
  authSubmitBtn.disabled = false;
  authMsg.textContent = error
    ? `送信に失敗しました: ${error.message}`
    : `${email} 宛にログイン用のリンクを送りました。メール内のリンクを開いてください。`;
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
