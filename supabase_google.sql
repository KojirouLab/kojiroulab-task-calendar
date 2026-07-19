-- Supabase の SQL Editor にこの内容を貼り付けて実行してください（app_state作成時と同じ場所）。

create table if not exists google_calendar_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  refresh_token text not null,
  calendar_id text not null default 'primary',
  connected_at timestamptz not null default now()
);

alter table google_calendar_accounts enable row level security;

-- クライアント（ブラウザ）からは接続状態の確認・解除だけできればよく、
-- refresh_token 自体の中身はEdge Function（service role）経由でのみ読み書きする。
create policy "select own row" on google_calendar_accounts
  for select using (auth.uid() = user_id);

create policy "delete own row" on google_calendar_accounts
  for delete using (auth.uid() = user_id);
