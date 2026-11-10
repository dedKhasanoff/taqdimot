-- Guruh Taqdimotlari: Supabase sxemasi.
-- Supabase → SQL Editor'da bir marta to'liq ishga tushiring.

-- 1. Adminlar ro'yxati (yuklash va o'chirish huquqi bor foydalanuvchilar)
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;

drop policy if exists "admin o'zini ko'radi" on public.admins;
create policy "admin o'zini ko'radi" on public.admins
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
  created_at timestamptz not null default now()
);
create index if not exists presentations_created_at_idx on public.presentations (created_at desc);
alter table public.presentations enable row level security;

drop policy if exists "hamma ko'radi" on public.presentations;
create policy "hamma ko'radi" on public.presentations
  for select to anon, authenticated using (true);

drop policy if exists "admin qo'shadi" on public.presentations;
create policy "admin qo'shadi" on public.presentations
  for insert to authenticated with check (public.is_admin());

drop policy if exists "admin o'zgartiradi" on public.presentations;
create policy "admin o'zgartiradi" on public.presentations
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin o'chiradi" on public.presentations;
create policy "admin o'chiradi" on public.presentations
  for delete to authenticated using (public.is_admin());

-- 3. Fayl ombori: ochiq o'qish, 20 MB, faqat PDF va PPTX
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('taqdimotlar', 'taqdimotlar', true, 20971520,
        array['application/pdf','application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "taqdimotlar: admin yuklaydi" on storage.objects;
create policy "taqdimotlar: admin yuklaydi" on storage.objects
  for insert to authenticated with check (bucket_id = 'taqdimotlar' and public.is_admin());

drop policy if exists "taqdimotlar: admin o'chiradi" on storage.objects;
create policy "taqdimotlar: admin o'chiradi" on storage.objects
  for delete to authenticated using (bucket_id = 'taqdimotlar' and public.is_admin());

-- Ochiq bucket fayllarni public URL orqali beradi, shuning uchun select qoidasi kerak emas.
-- Lekin o'chirishda Supabase avval qatorni o'qiydi, shuning uchun admin uchun select ham kerak:
drop policy if exists "taqdimotlar: admin o'qiydi" on storage.objects;
create policy "taqdimotlar: admin o'qiydi" on storage.objects
  for select to authenticated using (bucket_id = 'taqdimotlar' and public.is_admin());

-- 4. O'zingizni admin qilish (Authentication → Users'da foydalanuvchi yaratgandan keyin):
-- insert into public.admins (user_id)
--   select id from auth.users where email = 'sizning@email.uz';
