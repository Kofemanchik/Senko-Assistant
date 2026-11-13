// Общие помощники панели: состояние пользователя, таблицы, подписи ролей.
import { h, fmtDate } from '../assets/common.js';

export const state = { me: null, settings: {} };
export const ROLE = {
  admin: 'Администратор', chair: 'Председатель', judge: 'Судья', clerk: 'Секретарь',
  prosecutor_head: 'ГП / ЗГП', prosecutor: 'Прокурор', iid_head: 'Начальник IID', iid: 'Сотрудник IID', user: 'Гражданин', pending: 'Ожидает доступа',
};
export const COURT = ['admin', 'chair', 'judge', 'clerk'];
export const JUDGES = ['admin', 'chair', 'judge'];
export const LEAD = ['admin', 'chair'];
export const is = (...roles) => roles.includes(state.me.role);

export const HOLDER = { court: 'Суд', prosecutor: 'Прокуратура', iid: 'IID' };
export const FLOW = { draft: ['Черновик', 'gray'], review: ['На проверке', 'warn'], returned: ['Возвращено', 'bad'], approved: ['Утверждено', 'ok'], transferred: ['Передано', ''], rejected: ['Отклонено', 'bad'] };
export const CASE_ST = { open: 'Открыто', hearing: 'Слушание', decision: 'Решение', closed: 'Закрыто' };
export const CASE_KIND = { civil: 'Гражданское', criminal: 'Уголовное', admin: 'Административное', other: 'Иное' };
export const PROS_ST = { pending: ['Ждёт назначения', 'warn'], assigned: ['Назначен', 'ok'], declined: ['Отказ', 'bad'], withdrawn: ['Отозван', 'gray'] };
export const APP_ST = { new: ['Новая', 'warn'], review: ['На рассмотрении', ''], accepted: ['Принята', 'ok'], rejected: ['Отклонена', 'bad'] };

export const tag = (map, k) => { const [l, c] = map[k] || [k, 'gray']; return h('span', { class: 'tag ' + c }, l); };
export const ok = (res) => { if (res.error) throw res.error; return res.data; };
export const short = (s, n = 70) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
export const opts = (map) => Object.entries(map).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]);

export function table(cols, rows, onRow, empty = 'Пока пусто.') {
  if (!rows.length) return h('div', { class: 'card' }, h('p', { class: 'empty' }, empty));
  return h('div', { class: 'tbl-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c[0])))),
    h('tbody', {}, rows.map((r) => h('tr', { class: onRow ? 'click' : '', tabindex: onRow ? 0 : null,
      onclick: onRow ? () => onRow(r) : null, onkeydown: onRow ? (e) => { if (e.key === 'Enter') onRow(r); } : null },
      cols.map((c) => h('td', {}, c[1](r))))))));
}

// просрочка: возвращает число часов сверх срока или 0
export const overdueH = (since, limitH) => { const d = (Date.now() - new Date(since).getTime()) / 3600e3 - limitH; return d > 0 ? Math.floor(d) : 0; };
export const dtLocal = (v) => { const d = v ? new Date(v) : new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
export { fmtDate };
export const rerender = () => window.dispatchEvent(new Event('hashchange'));

// сервер: у сотрудника с привязкой всегда свой, у администратора (или без привязки) — выбранный в шапке
import { serverName } from '../assets/common.js';
export const srv = (req) => (state.server ? req.eq('server', state.server) : req);
export const srvOrBoth = (req) => (state.server ? req.or(`server.eq.${state.server},server.eq.`) : req);
export const srvLabel = (code) => h('span', { class: 'tag gray' }, serverName(state.settings, code));
