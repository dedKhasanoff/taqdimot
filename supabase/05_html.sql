-- HTML taqdimotlar uchun yangilanish: 3 tagacha fayl (PDF, PPTX, HTML),
-- HTML storage'da oddiy matn (text/plain) sifatida saqlanadi.
alter table public.presentations drop constraint if exists presentations_files_check;
alter table public.presentations add constraint presentations_files_check
  check (jsonb_typeof(files) = 'array' and jsonb_array_length(files) between 1 and 3);
update storage.buckets
  set allowed_mime_types = array['application/pdf','application/vnd.openxmlformats-officedocument.presentationml.presentation','image/jpeg','text/plain']
  where id = 'taqdimotlar';
