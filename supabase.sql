-- Supabase の SQL Editor にこの内容を貼り付けて実行してください。

create table if not exists app_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{"series":[],"weeklyMemos":{}}',
  updated_at timestamptz not null default now()
);

alter table app_state enable row level security;

create policy "select own row" on app_state
  for select using (auth.uid() = user_id);

create policy "insert own row" on app_state
  for insert with check (auth.uid() = user_id);

create policy "update own row" on app_state
  for update using (auth.uid() = user_id);
