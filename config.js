// Supabase loyihasi sozlamalari (Connect → .env.local).
// Publishable kalit ochiq kalit, uni saytga qo'yish xavfsiz (himoyani RLS qoidalari beradi).
// Hech qachon "secret" yoki "service_role" kalitni bu yerga qo'ymang.
window.TAQDIMOT_CONFIG = {
  supabaseUrl: 'https://puuqfzqqqrceyxnzgzpp.supabase.co',
  supabaseAnonKey: 'sb_publishable_STAaZr4sbaKPUX03XyKN5g_XNsNqmD-',
  bucket: 'taqdimotlar',
  // "Yuklab olish" tugmasi fayllarni shu Telegram bot orqali beradi (@ belgisisiz)
  telegramBot: 'taqdimotqabul_bot'
};
