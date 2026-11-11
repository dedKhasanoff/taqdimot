-- Mavzular uchun yangilanish (schema.sql allaqachon ishga tushirilgan bo'lsa).
alter table public.presentations add column if not exists topic text check (topic is null or char_length(topic) between 1 and 80);
