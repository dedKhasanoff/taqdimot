-- Muqova rasmlari uchun yangilanish (schema.sql allaqachon ishga tushirilgan bo'lsa).
alter table public.presentations add column if not exists cover text;
update storage.buckets
  set allowed_mime_types = array['application/pdf','application/vnd.openxmlformats-officedocument.presentationml.presentation','image/jpeg']
  where id = 'taqdimotlar';
