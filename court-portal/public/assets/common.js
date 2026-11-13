// Общие помощники для сайта и панели: клиент Supabase, построитель DOM, окна, уведомления.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { CONFIG } from './config.js';

export const configured = !/YOUR-/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_ANON_KEY);
export const sb = createClient(
  configured ? CONFIG.SUPABASE_URL : 'https://placeholder.supabase.co',
  configured ? CONFIG.SUPABASE_ANON_KEY : 'placeholder',
  { auth: { persistSession: true, autoRefreshToken: true } }
);

// h('div', {class:'x', onclick: fn}, 'текст', childNode) — текст всегда вставляется как текст, не как HTML
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (s, r = document) => r.querySelector(s);

export function fmtDate(v, withTime = false) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  const o = withTime ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'medium' };
  return d.toLocaleString('ru-RU', o);
}

// Человеческие сообщения вместо технических кодов базы
const ERR = {
  rate_limited: 'Слишком много отправок. Попробуйте позже.',
  closed: 'Приём заявок сейчас закрыт.',
  bad_nickname: 'Проверьте ник: от 2 до 60 символов.',
  bad_discord: 'Проверьте Discord: от 2 до 60 символов.',
  bad_position: 'Выберите должность из списка.',
  bad_text: 'Обстоятельства: от 30 до 8000 знаков.',
  bad_court: 'Выберите суд из списка.',
  bad_server: 'Выберите сервер из списка.',
  bad_filer: 'Выберите, кто подаёт иск.',
  bad_title: 'Название иска: от 3 до 200 знаков.',
  bad_plaintiff: 'Укажите имя истца (от 2 знаков).',
  bad_static: 'Статик состоит только из цифр (до 9 знаков).',
  bad_lawyer: 'Адвокату нужно указать имя и номер лицензии.',
  bad_contacts: 'Укажите контакты для связи.',
  bad_defendants: 'Добавьте хотя бы одного ответчика с именем.',
  bad_requests: 'Добавьте хотя бы одно требование.',
  bad_url: 'Ссылка должна начинаться с http:// или https://',
  bad_material: 'Проверьте тип и текст материала (от 5 знаков).',
  not_found: 'Не найдено, либо нет доступа.',
  char_limit: 'Можно завести не больше трёх персонажей.',
  bad_target: 'Дальше передавать некуда.',
  bad_action: 'Неизвестное действие.',
  last_admin: 'Нельзя убрать последнего администратора.',
  forbidden: 'Недостаточно прав.',
};
export function errText(e) {
  const m = String((e && (e.message || e.error_description)) || e || '');
  for (const k of Object.keys(ERR)) if (m.includes(k)) return ERR[k];
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Нет связи с сервером.';
  if (/Invalid login/i.test(m)) return 'Неверный логин или пароль.';
  if (/already registered/i.test(m)) return 'Такой логин уже занят.';
  if (/invalid format|Unable to validate email|email address.*invalid/i.test(m)) return 'Supabase не принял служебную почту. Поменяйте LOGIN_DOMAIN в config.js (см. README).';
  if (/Password should be/i.test(m)) return 'Пароль слишком простой: не короче 8 знаков.';
  if (/violates check constraint/i.test(m)) return 'Проверьте введённые данные.';
  if (/row-level security|permission denied/i.test(m)) return 'Недостаточно прав.';
  if (/duplicate key/i.test(m)) return 'Такая запись уже существует.';
  return m || 'Что-то пошло не так.';
}

// ---- уведомления ----
let toastBox;
export function toast(msg, kind = 'info') {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const t = h('div', { class: 'toast ' + kind }, msg);
  toastBox.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 5000 : 2800);
}

// ---- окна в стиле сайта (вместо системных alert/confirm) ----
export function modal({ title, body, actions = [], wide = false }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (val) => {
      back.classList.remove('in');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => { back.remove(); prevFocus && prevFocus.focus && prevFocus.focus(); }, 200);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(undefined); };
    const btns = actions.map((a) => h('button', {
      class: 'btn ' + (a.kind || ''), type: 'button',
      onclick: async () => {
        if (a.run) {
          btns.forEach((b) => (b.disabled = true));
          try { const r = await a.run(); if (r === false) { btns.forEach((b) => (b.disabled = false)); return; } close(a.value ?? true); }
          catch (e) { toast(errText(e), 'err'); btns.forEach((b) => (b.disabled = false)); }
        } else close(a.value);
      },
    }, a.label));
    const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-h' }, h('h3', {}, title), h('button', { class: 'x', type: 'button', 'aria-label': 'Закрыть', onclick: () => close(undefined) }, '×')),
      h('div', { class: 'modal-b' }, body),
      actions.length ? h('div', { class: 'modal-f' }, btns) : null);
    const back = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === back) close(undefined); } }, box);
    document.body.append(back);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => { back.classList.add('in'); const f = box.querySelector('input,textarea,select,button.primary'); f && f.focus(); });
  });
}

export async function confirmDlg(text, okLabel = 'Подтвердить', danger = false) {
  const r = await modal({
    title: 'Подтверждение', body: h('p', {}, text),
    actions: [{ label: 'Отмена', value: false }, { label: okLabel, kind: danger ? 'danger' : 'primary', value: true }],
  });
  return r === true;
}

// ---- формы ----
export function field(label, input, hint) {
  return h('label', { class: 'fld' }, h('span', { class: 'fld-l' }, label), input, hint ? h('small', {}, hint) : null);
}
export function input(attrs = {}) { return h('input', { type: 'text', ...attrs }); }
export function textarea(attrs = {}) { return h('textarea', { rows: 4, ...attrs }); }
export function select(options, value, attrs = {}) {
  const s = h('select', attrs, options.map((o) => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return h('option', { value: v }, l);
  }));
  if (value != null) s.value = value;
  return s;
}

// ---- вход по логину: к логину дописывается служебный домен; адрес с «@» работает как обычная почта ----
export const LOGIN_RE = /^[a-z0-9_.-]{3,32}$/;
export function toEmail(v) {
  v = String(v || '').trim();
  if (v.includes('@')) return v;
  return `${v.toLowerCase()}@${CONFIG.LOGIN_DOMAIN || 'users.cp-portal.app'}`;
}
export const loginOk = (v) => String(v || '').includes('@') || LOGIN_RE.test(String(v || '').trim().toLowerCase());

export const isUrl = (u) => /^https?:\/\/[^\s[\]]{3,}$/i.test(String(u || '').trim());

export function debounce(fn, ms = 300) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Подстановка {{ключ}} в шаблон; пустые поля превращаются в «—»
export function renderTemplate(body, values) {
  const today = new Date().toLocaleDateString('ru-RU');
  return String(body).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => {
    if (k === 'today') return today;
    const v = (values[k] ?? '').toString().trim();
    return v || '—';
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Скопировано', 'ok'); return true; }
  catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    ta.remove(); toast(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'ok' : 'err'); return ok;
  }
}

// Тема: авто / светлая / тёмная
export function initTheme(btn) {
  const apply = (t) => { if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  let cur = 'auto'; try { cur = localStorage.getItem('cp-theme') || 'auto'; } catch {}
  apply(cur);
  const label = { auto: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: тёмная' };
  const upd = () => { btn.textContent = { auto: '◐', light: '☀', dark: '☾' }[cur]; btn.title = btn.ariaLabel = label[cur]; };
  upd();
  btn.addEventListener('click', () => {
    cur = { auto: 'light', light: 'dark', dark: 'auto' }[cur];
    try { localStorage.setItem('cp-theme', cur); } catch {}
    apply(cur); upd();
  });
}

export function setupNotice() {
  return h('div', { class: 'card warn' }, h('h3', {}, 'Сайт ещё не подключён к базе'),
    h('p', {}, 'Откройте файл assets/config.js и впишите адрес проекта Supabase и anon-ключ. Подробности в README.'));
}

// ---- подписи стадий и исходов иска (общие для сайта и панели) ----
export const STAGE = {
  new: ['Подан', ''], processing: ['В работе', 'warn'], prosecutor: ['Участие прокурора', 'warn'],
  hearing_set: ['Заседание назначено', ''], hearing_held: ['Заседание проведено', ''], decision: ['Решение готовится', ''], closed: ['Завершён', 'gray'],
};
export const OUTCOME = { granted: ['Удовлетворён', 'ok'], partly: ['Удовлетворён частично', 'ok'], denied: ['Отказано', 'bad'], returned: ['Возвращён', 'warn'], withdrawn: ['Отозван', 'gray'], other: ['Иное', 'gray'] };
export const stageTag = (stage, outcome) => {
  const [l, c] = stage === 'closed' && OUTCOME[outcome] ? OUTCOME[outcome] : (STAGE[stage] || [stage, '']);
  return h('span', { class: 'tag ' + c }, l);
};
export const MATERIAL = { motion: 'Ходатайство', evidence: 'Доказательства', response: 'Отзыв ответчика' };
export const MSTATUS = { pending: ['На рассмотрении', 'warn'], accepted: ['Принято', 'ok'], rejected: ['Отклонено', 'bad'] };

// ---- серверы (San Francisco, Orlando): выбранный сервер хранится в браузере ----
export const SERVER_KEY = 'cp-server';
export const serverList = (settings) => (Array.isArray(settings.servers) ? settings.servers : []).filter((x) => x && x.code);
export function currentServer(settings) {
  const list = serverList(settings); let v = '';
  try { v = localStorage.getItem(SERVER_KEY) || ''; } catch {}
  return list.some((x) => x.code === v) ? v : (list[0] ? list[0].code : '');
}
export const serverName = (settings, code) => (serverList(settings).find((x) => x.code === code) || {}).name || code || '—';
