-- Guruh Taqdimotlari: Supabase sxemasi.
-- Supabase → SQL Editor'da bir marta to'liq ishga tushiring.

-- 1. Adminlar ro'yxati (yuklash va o'chirish huquqi bor foydalanuvchilar)
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;

drop policy if exists "admins_select_own" on public.admins;
create policy "admins_select_own" on public.admins
  for select to authenticated using (user_id = auth.uid());

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- 2. Taqdimotlar
create table if not exists public.presentations (
  id uuid primary key default gen_random_uuid(),
  "group" text not null check ("group" in ('101','102','103','104','105','106','107','108','109','110')),
  title text not null check (char_length(title) between 1 and 200),
  student text not null check (char_length(student) between 1 and 120),
  -- [{kind: "pdf"|"pptx", path, name, size}]
  files jsonb not null default '[]'::jsonb check (jsonb_typeof(files) = 'array' and jsonb_array_length(files) between 1 and 2),
  cover text, -- birinchi slayd rasmi (storage yo'li)
  topic text check (topic is null or char_length(topic) between 1 and 80), -- mavzu
  created_at timestamptz not null default now()
);
alter table public.presentations add column if not exists cover text;
alter table public.presentations add column if not exists topic text check (topic is null or char_length(topic) between 1 and 80);
create index if not exists presentations_created_at_idx on public.presentations (created_at desc);
alter table public.presentations enable row level security;

drop policy if exists "pres_select_all" on public.presentations;
create policy "pres_select_all" on public.presentations
  for select to anon, authenticated using (true);

drop policy if exists "pres_insert_admin" on public.presentations;
create policy "pres_insert_admin" on public.presentations
  for insert to authenticated with check (public.is_admin());

drop policy if exists "pres_update_admin" on public.presentations;
create policy "pres_update_admin" on public.presentations
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "pres_delete_admin" on public.presentations;
create policy "pres_delete_admin" on public.presentations
  for delete to authenticated using (public.is_admin());

-- 3. Fayl ombori: ochiq o'qish, 20 MB, PDF, PPTX va muqova rasmlari
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('taqdimotlar', 'taqdimotlar', true, 20971520,
        array['application/pdf','application/vnd.openxmlformats-officedocument.presentationml.presentation','image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "files_insert_admin" on storage.objects;
create policy "files_insert_admin" on storage.objects
  for insert to authenticated with check (bucket_id = 'taqdimotlar' and public.is_admin());

drop policy if exists "files_delete_admin" on storage.objects;
create policy "files_delete_admin" on storage.objects
  for delete to authenticated using (bucket_id = 'taqdimotlar' and public.is_admin());

-- Ochiq bucket fayllarni public URL orqali beradi, shuning uchun select qoidasi kerak emas.
-- Lekin o'chirishda Supabase avval qatorni o'qiydi, shuning uchun admin uchun select ham kerak:
drop policy if exists "files_select_admin" on storage.objects;
create policy "files_select_admin" on storage.objects
  for select to authenticated using (bucket_id = 'taqdimotlar' and public.is_admin());

-- 4. Telegram bot suhbat holati (faqat service kalit bilan ishlaydi)
create table if not exists public.bot_sessions (
  chat_id bigint primary key,
  step text not null default 'idle',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.bot_sessions enable row level security;

-- 5. O'zingizni admin qilish (Authentication → Users'da foydalanuvchi yaratgandan keyin):
-- insert into public.admins (user_id)
--   select id from auth.users where email = 'sizning@email.uz';
