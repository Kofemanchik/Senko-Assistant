// Заполните двумя значениями из Supabase: Project Settings → API.
// anon-ключ публичный, его можно держать в коде: доступ ограничен правилами базы (RLS).
export const CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',
  // Вход по логину устроен так: к логину дописывается этот домен и получается служебная «почта».
  // Письма на неё не отправляются. Если Supabase не принимает домен, впишите любой другой.
  LOGIN_DOMAIN: 'users.cp-portal.app',
};
