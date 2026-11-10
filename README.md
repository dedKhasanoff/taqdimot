# Guruh Taqdimotlari

101–110 guruhlar uchun sayt: 10 ta karta, har birida shu guruh o'quvchilarining taqdimotlari (PDF va PPTX). Qidiruv bor. Til: o'zbekcha.

- Ko'rish hamma uchun ochiq, kirish shart emas.
- Yuklash va o'chirish faqat admin uchun (Supabase hisobi bilan kiradi).
- Fayllar: faqat PDF va PPTX, har biri 20 MB gacha.

## Fayllar
| Fayl | Nima |
|---|---|
| `index.html` | Sahifa va dizayn (CSS) |
| `app.js` | Sayt mantig'i: guruhlar, qidiruv, kirish, yuklash, o'chirish |
| `config.js` | Supabase manzili va ochiq (anon) kalit |
| `supabase/schema.sql` | Jadval, admin ro'yxati, ruxsat qoidalari, fayl ombori |
| `netlify.toml` | Netlify sozlamasi |

## O'rnatish

### 1. Supabase
1. [supabase.com](https://supabase.com) da yangi loyiha oching (bepul tarif yetadi).
2. **SQL Editor** → `supabase/schema.sql` ichidagi hamma narsani qo'yib, **Run** bosing.
3. **Authentication → Providers → Email**: yoqilgan bo'lsin. **Authentication → Sign In / Up**: *Allow new users to sign up* ni **o'chiring** (begona odam ro'yxatdan o'ta olmasin).
4. **Authentication → Users → Add user**: o'zingiz uchun email va parol bilan foydalanuvchi yarating.
5. SQL Editor'da o'zingizni admin qiling:
   ```sql
   insert into public.admins (user_id)
     select id from auth.users where email = 'sizning@email.uz';
   ```
6. **Project Settings → API** dan `Project URL` va `anon public` kalitni oling va `config.js` ga yozing.
   `service_role` kalitni hech qachon saytga qo'ymang.

### 2. Netlify
- Eng osoni: [app.netlify.com/drop](https://app.netlify.com/drop) ga papkani sudrab tashlang.
- Yoki GitHub repozitoriyani Netlify'ga ulang: build buyrug'i kerak emas, publish papka `.` (`netlify.toml` da yozilgan).

### 3. Foydalanish
Saytda o'ng yuqoridagi **Kirish** tugmasi orqali admin sifatida kiring. Guruh kartasini oching, pastda yuklash formasi chiqadi.

## Ma'lumot modeli
Jadval `presentations`:
```
{id, group: "101".."110", title, student,
 files: [{kind: "pdf"|"pptx", path, name, size}], created_at}
```
Fayllar `taqdimotlar` bucket'ida `<guruh>/<uuid>.<pdf|pptx>` yo'lida saqlanadi.

## Himoya
Cheklovlar brauzerda ham, serverda ham tekshiriladi:
- RLS: `presentations` ni hamma o'qiydi, faqat `admins` jadvalidagilar yozadi va o'chiradi.
- Storage: bucket'da 20 MB va MIME turi (PDF, PPTX) cheklovi bor; yuklash va o'chirish faqat admin uchun.

## Dizayn
Ranglar `:root` ichidagi tokenlarda, yorug' va qorong'i mavzu bor. Shriftlar: Bricolage Grotesque (sarlavha), Onest (matn).
