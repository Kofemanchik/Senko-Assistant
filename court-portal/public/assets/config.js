// Заполните двумя значениями из Supabase: Project Settings → API.
// anon-ключ публичный, его можно держать в коде: доступ ограничен правилами базы (RLS).
export const CONFIG = {
  SUPABASE_URL: 'https://bduoulbiwwpjhegxjwdx.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_jCVWXXifDV6fi02iU-VgzQ_5Q94Y20m',
  // Вход по логину устроен так: к логину дописывается этот домен и получается служебная «почта».
  // Письма на неё не отправляются. Если Supabase не принимает домен, впишите любой другой.
  LOGIN_DOMAIN: 'users.cp-portal.app',
};
