// Судебная панель: вход, роли, выбор сервера, каркас и маршруты.
import { sb, configured, h, $, errText, toast, field, input, initTheme, setupNotice, toEmail, loginOk, serverList, serverName } from '../assets/common.js';
import { state, ROLE, COURT, JUDGES, ok, srv } from './ui.js';
import { dash, claims, claimCard, hearings } from './claims.js';
import { cases, caseCard, prosecution } from './cases.js';
import { decisions, apps, laws, users, settings, audit } from './admin.js';

const root = $('#root');
const STAFF = [...COURT, 'prosecutor_head', 'prosecutor', 'iid_head', 'iid'];
const PROS = ['prosecutor_head', 'prosecutor'];

// ---------------------------------------------------------------- вход
function authScreen(note) {
  let mode = 'login';
  const login = input({ autocomplete: 'username', placeholder: 'логин или почта', maxlength: 64 });
  const pass = input({ type: 'password', autocomplete: 'current-password' });
  const nick = input({ maxlength: 40, placeholder: 'Имя Фамилия' });
  const nickF = field('Имя', nick); nickF.hidden = true;
  const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Войти');
  const sw = h('button', { class: 'btn ghost sm', type: 'button' }, 'Создать аккаунт сотрудника');
  const title = h('h2', {}, 'Вход для сотрудников');
  sw.onclick = () => {
    mode = mode === 'login' ? 'signup' : 'login';
    title.textContent = mode === 'login' ? 'Вход для сотрудников' : 'Регистрация сотрудника';
    btn.textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
    sw.textContent = mode === 'login' ? 'Создать аккаунт сотрудника' : 'У меня уже есть аккаунт';
    nickF.hidden = mode === 'login'; pass.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  };
  const form = h('form', { class: 'card login view' }, title, note ? h('p', { class: 'muted' }, note) : null,
    field('Логин', login), nickF, field('Пароль', pass, 'Не короче 8 знаков'), btn, h('div', { style: 'margin-top:10px;text-align:center' }, sw),
    h('p', { class: 'muted', style: 'margin:14px 0 0;font-size:.9rem' }, 'После регистрации доступ и сервер выдаёт администратор.'));
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!loginOk(login.value)) return toast('Логин: 3–32 знака, латиница, цифры и _ . -', 'err');
    if (pass.value.length < 8) return toast('Пароль не короче 8 знаков', 'err');
    btn.disabled = true;
    try {
      const email = toEmail(login.value);
      const r = mode === 'login' ? await sb.auth.signInWithPassword({ email, password: pass.value })
        : await sb.auth.signUp({ email, password: pass.value, options: { data: { kind: 'staff', login: login.value.trim().toLowerCase(), nick: nick.value.trim(), consent: 'true' } } });
      if (r.error) throw r.error;
      if (mode === 'signup' && !r.data.session) { toast('Аккаунт создан, но нужно подтверждение почты. Отключите «Confirm email» (см. README).', 'err'); return; }
      await boot();
    } catch (err) { toast(errText(err), 'err'); } finally { btn.disabled = false; }
  };
  root.replaceChildren(form);
}

// ------------------------------------------------------------ каркас панели
const NAV = [
  ['dash', 'Обзор', COURT],
  ['claims', 'Иски', [...COURT, ...PROS], 'claims'],
  ['hearings', 'Заседания', COURT],
  ['cases', 'Дела', STAFF],
  ['pros', 'Прокуратура', ['admin', ...PROS], 'pros'],
  ['decisions', 'Решения', COURT],
  ['apps', 'Заявки на работу', JUDGES, 'apps'],
  ['laws', 'Законы', JUDGES],
  ['users', 'Пользователи', ['admin']],
  ['settings', 'Настройки и Discord', ['admin']],
  ['audit', 'Журнал', ['admin']],
];
const VIEWS = {
  dash, hearings, decisions, apps, laws, users, settings, audit, pros: prosecution,
  claims: (a) => (a[0] ? claimCard(a) : claims()), cases: (a) => (a[0] ? caseCard(a) : cases()),
};
const allowed = () => NAV.filter((n) => n[2].includes(state.me.role));

async function refreshCounters() {
  const r = state.me.role;
  const cnt = async (q) => { const x = await q; return x.count || 0; };
  const [c, a, p] = await Promise.all([
    COURT.includes(r) ? cnt(srv(sb.from('cp_claims').select('id', { count: 'exact', head: true }).eq('stage', 'new'))) : 0,
    JUDGES.includes(r) ? cnt(srv(sb.from('cp_applications').select('id', { count: 'exact', head: true }).eq('status', 'new'))) : 0,
    ['admin', 'prosecutor_head'].includes(r) ? cnt(sb.from('cp_pros_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending')) : 0,
  ]);
  const counters = { claims: c, apps: a, pros: p };
  document.querySelectorAll('.side a').forEach((el) => {
    const n = counters[el.dataset.cnt]; const b = el.querySelector('.cnt');
    if (b) b.remove(); if (n) el.append(h('span', { class: 'cnt' }, n));
  });
}

function shell() {
  const side = h('nav', { class: 'side', 'aria-label': 'Разделы панели' }, allowed().map((n) => h('a', { href: '#/' + n[0], dataset: { r: n[0], cnt: n[3] || '' } }, n[1])));
  const main = h('section', { id: 'pview', style: 'min-width:0' });
  root.replaceChildren(h('div', { class: 'layout' }, side, main));
  window.onhashchange = route; route(); refreshCounters();
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const names = allowed().map((n) => n[0]);
  let name = parts[0] || names[0];
  if (!names.includes(name)) name = names[0];
  document.querySelectorAll('.side a').forEach((a) => a.classList.toggle('on', a.dataset.r === name));
  const pv = $('#pview'); pv.replaceChildren(h('div', { class: 'bar-spin' }));
  try { pv.replaceChildren(h('div', { class: 'view' }, await VIEWS[name](parts.slice(1)))); }
  catch (e) { pv.replaceChildren(h('p', { class: 'empty' }, errText(e))); }
  refreshCounters();
}

function setupServer() {
  const sel = $('#srvSel'); const list = serverList(state.settings);
  const bound = state.me.server || '';
  if (bound) { state.server = bound; sel.hidden = true; return; }
  let v = ''; try { v = localStorage.getItem('cp-psrv') || ''; } catch {}
  state.server = list.some((x) => x.code === v) ? v : '';
  sel.replaceChildren(h('option', { value: '' }, 'Все серверы'), ...list.map((x) => h('option', { value: x.code }, x.name)));
  sel.value = state.server; sel.hidden = false;
  sel.onchange = () => { state.server = sel.value; try { localStorage.setItem('cp-psrv', state.server); } catch {} route(); };
}

// ---------------------------------------------------------------- запуск
async function boot() {
  const { data: s } = await sb.auth.getSession();
  const uid = s && s.session && s.session.user && s.session.user.id;
  $('#logout').hidden = !uid;
  if (!uid) { $('#who').textContent = ''; $('#srvSel').hidden = true; return authScreen(); }
  const me = ok(await sb.from('cp_profiles').select('*').eq('id', uid).maybeSingle());
  if (!me) return authScreen('Профиль не найден. Войдите заново.');
  state.me = me;
  $('#who').textContent = `${me.nick || me.login} · ${ROLE[me.role] || me.role}${me.server ? ' · ' + serverName(state.settings, me.server) : ''}`;
  if (me.role === 'pending') return root.replaceChildren(h('div', { class: 'card login' }, h('h2', {}, 'Ожидайте доступа'), h('p', {}, 'Аккаунт создан. Администратор выдаст вам роль и сервер, после этого обновите страницу.')));
  if (!STAFF.includes(me.role)) return root.replaceChildren(h('div', { class: 'card login' }, h('h2', {}, 'Это вход для сотрудников'), h('p', {}, 'Ваш кабинет находится на основном сайте.'), h('a', { class: 'btn', href: '../' }, 'На сайт')));
  setupServer(); shell();
}

initTheme($('#themeBtn'));
$('#logout').onclick = async () => { await sb.auth.signOut(); await boot(); };
if (!configured) root.replaceChildren(setupNotice());
else {
  try { const { data } = await sb.from('cp_settings').select('key,value'); state.settings = Object.fromEntries((data || []).map((r) => [r.key, r.value])); } catch {}
  await boot();
}
