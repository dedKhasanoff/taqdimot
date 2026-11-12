-- Telegram bot uchun: suhbat holati jadvali.
-- RLS yoqilgan, qoidalar yo'q: faqat bot (service kalit bilan) o'qiy va yoza oladi.
create table if not exists public.bot_sessions (
  chat_id bigint primary key,
  step text not null default 'idle',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.bot_sessions enable row level security;
