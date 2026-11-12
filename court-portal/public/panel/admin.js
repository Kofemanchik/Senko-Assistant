// Решения, заявки на работу, законы, сотрудники, настройки с вебхуками, журнал.
import { sb, h, errText, toast, modal, confirmDlg, field, input, textarea, select, fmtDate, serverList } from '../assets/common.js';
import { state, is, ROLE, JUDGES, APP_ST, tag, ok, short, opts, table, rerender, srv, srvOrBoth, srvLabel } from './ui.js';

const safe = (fn) => async () => { try { await fn(); } catch (e) { toast(errText(e), 'err'); } };
const lines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);

// ------------------------------------------------------------------ решения
export async function decisions() {
  const rows = ok(await srv(sb.from('cp_decisions').select('*').order('dt', { ascending: false }).order('id', { ascending: false }).limit(200))) || [];
  const edit = (d) => {
    const f = { title: input({ maxlength: 200, value: d.title || '' }), no: input({ maxlength: 40, value: d.no || '' }), verdict: input({ maxlength: 120, value: d.verdict || '' }),
      person: input({ maxlength: 120, value: d.person || '' }), dt: input({ type: 'date', value: d.dt || new Date().toISOString().slice(0, 10) }), text: textarea({ rows: 10, maxlength: 20000 }) };
    f.text.value = d.text || '';
    const pub = h('input', { type: 'checkbox', checked: !!d.public }); const anon = h('input', { type: 'checkbox', checked: d.anon !== false });
    modal({ title: d.id ? 'Решение' : 'Новое решение', wide: true, body: h('div', {}, field('Заголовок', f.title), h('div', { class: 'grid2' }, field('Номер', f.no), field('Дата', f.dt)),
      h('div', { class: 'grid2' }, field('Вердикт', f.verdict), field('Лицо', f.person)), field('Текст', f.text), h('label', { class: 'check' }, pub, ' Опубликовано'), h('label', { class: 'check' }, anon, ' Скрыть имя лица')),
    actions: [{ label: 'Отмена', value: false }, { label: 'Сохранить', kind: 'primary', run: async () => {
      if (f.title.value.trim().length < 3 || f.text.value.trim().length < 10) { toast('Заполните заголовок и текст', 'err'); return false; }
      const row = { title: f.title.value.trim(), no: f.no.value.trim(), verdict: f.verdict.value.trim(), person: f.person.value.trim(), dt: f.dt.value, text: f.text.value.trim(), public: pub.checked, anon: anon.checked };
      if (d.id) ok(await sb.from('cp_decisions').update(row).eq('id', d.id)); else ok(await sb.from('cp_decisions').insert({ ...row, author: state.me.nick || state.me.login }));
      rerender(); } }] });
  };
  return h('div', {}, h('div', { class: 'row', style: 'justify-content:space-between' }, h('h1', {}, 'Решения'), is(...JUDGES) ? h('button', { class: 'btn primary', type: 'button', onclick: () => edit({}) }, '+ Новое') : null),
    table([['Дата', (r) => fmtDate(r.dt)], ['Сервер', (r) => srvLabel(r.server)], ['№', (r) => r.no || '—'], ['Название', (r) => short(r.title, 60)], ['Вердикт', (r) => r.verdict || '—'], ['Публикация', (r) => h('span', { class: 'tag ' + (r.public ? 'ok' : 'gray') }, r.public ? 'опубликовано' : 'черновик')]],
      rows, is(...JUDGES) ? edit : null));
}

// ------------------------------------------------------------------- заявки
export async function apps() {
  const box = h('div', {});
  const st = select([['', 'Все'], ...opts(APP_ST)], 'new');
  async function load() {
    let req = srv(sb.from('cp_applications').select('*').order('created_at', { ascending: false }).limit(200)); if (st.value) req = req.eq('status', st.value);
    box.replaceChildren(table([['№', (r) => r.id], ['Сервер', (r) => srvLabel(r.server)], ['Дата', (r) => fmtDate(r.created_at, true)], ['Ник', (r) => r.nickname], ['Должность', (r) => r.position], ['Статус', (r) => tag(APP_ST, r.status)]], ok(await req), open));
  }
  function open(a) {
    const note = input({ maxlength: 500, value: a.note || '', placeholder: 'Комментарий (попадёт в Discord)' });
    const set = (status) => async () => { ok(await sb.from('cp_applications').update({ status, note: note.value.trim(), decided_by: state.me.nick || '', decided_at: ['accepted', 'rejected'].includes(status) ? new Date().toISOString() : null }).eq('id', a.id)); toast('Сохранено', 'ok'); rerender(); };
    modal({ title: `Заявка № ${a.id}: ${a.nickname}`, wide: true, body: h('div', {}, h('p', {}, `${a.position} · Discord: ${a.discord} · ${fmtDate(a.created_at, true)}`),
      (a.answers || []).map((x) => h('div', { class: 'qa' }, h('b', {}, x.q), x.a)), field('Комментарий', note)),
    actions: [{ label: 'Закрыть', value: false }, { label: 'В рассмотрение', run: set('review') }, { label: 'Отклонить', kind: 'danger', run: set('rejected') }, { label: 'Принять', kind: 'primary', run: set('accepted') }] });
  }
  st.onchange = load; await load();
  return h('div', {}, h('h1', {}, 'Заявки на работу'), h('div', { class: 'toolbar' }, st), box);
}

// ------------------------------------------------------------------- законы
export async function laws() {
  const box = h('div', {}); const q = input({ type: 'search', placeholder: 'Поиск…' });
  async function load() {
    let req = srvOrBoth(sb.from('cp_laws').select('*').order('code').order('sort').order('article').limit(200));
    const term = q.value.replace(/[%,()*\\]/g, ' ').trim(); if (term) req = req.or(`title.ilike.%${term}%,article.ilike.${term}%,code.ilike.${term}%`);
    box.replaceChildren(table([['Сервер', (r) => (r.server ? srvLabel(r.server) : 'оба')], ['Кодекс', (r) => r.code], ['Статья', (r) => r.article], ['Название', (r) => short(r.title, 70)]], ok(await req), edit));
  }
  function edit(l) {
    const f = { code: input({ maxlength: 20, value: l.code || '' }), article: input({ maxlength: 20, value: l.article || '' }), title: input({ maxlength: 200, value: l.title || '' }), sort: input({ type: 'number', value: l.sort ?? 0 }), body: textarea({ rows: 10 }), server: select([['', 'Оба сервера'], ...serverList(state.settings).map((x) => [x.code, x.name])], l.server ?? state.server ?? '') };
    f.body.value = l.body || '';
    modal({ title: l.id ? 'Статья' : 'Новая статья', wide: true, body: h('div', {}, h('div', { class: 'grid2' }, field('Кодекс', f.code), field('Статья', f.article)), field('Сервер', f.server), field('Название', f.title), field('Порядок', f.sort), field('Текст', f.body)),
      actions: [{ label: 'Отмена', value: false }, l.id ? { label: 'Удалить', kind: 'danger', run: async () => { if (!(await confirmDlg('Удалить статью?', 'Удалить', true))) return false; ok(await sb.from('cp_laws').delete().eq('id', l.id)); load(); } } : null,
        { label: 'Сохранить', kind: 'primary', run: async () => {
          if (!f.code.value.trim() || !f.article.value.trim()) { toast('Укажите кодекс и номер статьи', 'err'); return false; }
          const row = { server: f.server.value, code: f.code.value.trim(), article: f.article.value.trim(), title: f.title.value.trim(), body: f.body.value, sort: Number(f.sort.value) || 0, updated_at: new Date().toISOString() };
          if (l.id) ok(await sb.from('cp_laws').update(row).eq('id', l.id)); else ok(await sb.from('cp_laws').insert(row)); load(); } }].filter(Boolean) });
  }
  q.addEventListener('input', (() => { let t; return () => { clearTimeout(t); t = setTimeout(load, 300); }; })());
  await load();
  return h('div', {}, h('div', { class: 'row', style: 'justify-content:space-between' }, h('h1', {}, 'Законы'), h('button', { class: 'btn primary', type: 'button', onclick: () => edit({}) }, '+ Статья')), h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, q)), box);
}

// -------------------------------------------------------------- сотрудники
export async function users() {
  const rows = ok(await sb.from('cp_profiles').select('*').order('created_at')) || [];
  const roleSel = (u) => { const s = select(Object.entries(ROLE), u.role); s.onchange = safe(async () => { ok(await sb.from('cp_profiles').update({ role: s.value }).eq('id', u.id)); toast('Роль изменена', 'ok'); }); s.onclick = (e) => e.stopPropagation(); return s; };
  const srvSel = (u) => { const s = select([['', 'Все серверы'], ...serverList(state.settings).map((x) => [x.code, x.name])], u.server || ''); s.onchange = safe(async () => { ok(await sb.from('cp_profiles').update({ server: s.value }).eq('id', u.id)); toast('Сервер изменён', 'ok'); }); s.onclick = (e) => e.stopPropagation(); return s; };
  return h('div', {}, h('h1', {}, 'Пользователи и роли'), h('p', { class: 'muted' }, 'Новые сотрудники регистрируются в панели и ждут здесь. Выдайте им роль. Граждане регистрируются на сайте.'),
    table([['Логин', (u) => u.login || u.email], ['Сервер', srvSel], ['Ник', (u) => u.nick || '—'], ['Discord', (u) => u.discord || '—'], ['С', (u) => fmtDate(u.created_at)], ['Роль', roleSel]], rows));
}

// ---------------------------------------------------------------- настройки
const HOOKS = { application: 'Новая заявка', application_result: 'Решение по заявке', claim: 'Новый иск', assign: 'Судья назначен', hearing: 'Заседание назначено', case: 'Новое дело', decision: 'Решение опубликовано', pros_request: 'Запрос прокурора', pros_assign: 'Прокурор назначен', transfer: 'Передача дела' };
export async function settings() {
  const s = state.settings;
  const save = async (key, value) => { ok(await sb.from('cp_settings').upsert({ key, value, public: true, updated_at: new Date().toISOString() })); s[key] = value; toast('Сохранено', 'ok'); };
  const site = s.site || {};
  const name = input({ maxlength: 60, value: site.name || '' }), tag_ = input({ maxlength: 200, value: site.tagline || '' }), foot = input({ maxlength: 200, value: site.footer || '' });
  const open = h('input', { type: 'checkbox', checked: s.app_open === true });
  const area = (v, ph) => { const t = textarea({ rows: 5, placeholder: ph }); t.value = v; return t; };
  const pos = area((s.app_positions || []).join('\n')), qs = area((s.app_questions || []).join('\n')), cats = area((s.claim_cats || []).join('\n')), fees = area((s.fees || []).join('\n'));
  const policy = area(typeof s.policy === 'string' ? s.policy : '');
  const dlv = { start_h: 48, pros_h: 72, decide_d: 10, ...(s.deadlines || {}) };
  const d1 = input({ type: 'number', min: 1, value: dlv.start_h }), d2 = input({ type: 'number', min: 1, value: dlv.pros_h }), d3 = input({ type: 'number', min: 1, value: dlv.decide_d });
  const courtsBox = h('div', {}); const courts = (s.courts || []).map((c) => ({ ...c }));
  const drawCourts = () => courtsBox.replaceChildren(...courts.map((c, i) => h('div', { class: 'li-row' }, h('div', { class: 'grid4' }, select(serverList(s).map((x) => [x.code, x.name]), c.server || (serverList(s)[0] || {}).code, { onchange: (e) => { c.server = e.target.value; } }),
    input({ maxlength: 8, value: c.code, placeholder: 'Код (SFDC)', oninput: (e) => { c.code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); } }),
    input({ maxlength: 80, value: c.name, placeholder: 'Название', oninput: (e) => { c.name = e.target.value; } }),
    input({ maxlength: 300, value: c.forum || '', placeholder: 'Раздел форума (ссылка)', oninput: (e) => { c.forum = e.target.value; } })),
  h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { courts.splice(i, 1); drawCourts(); } }, '✕'))), h('button', { class: 'btn sm', type: 'button', onclick: () => { courts.push({ code: '', server: (serverList(s)[0] || {}).code, name: '', forum: '' }); drawCourts(); } }, '+ Суд'));
  drawCourts();
  const card = (t, body, onSave) => h('div', { class: 'card' }, h('h3', {}, t), body, h('button', { class: 'btn primary sm', type: 'button', onclick: safe(onSave) }, 'Сохранить'));

  // вебхуки
  const hooks = ok(await sb.from('cp_webhooks').select('*')) || []; const byEv = Object.fromEntries(hooks.map((x) => [x.event, x]));
  const hookRows = Object.entries(HOOKS).map(([ev, label]) => {
    const cur = byEv[ev]; const url = input({ placeholder: cur ? 'адрес сохранён, введите новый для замены' : 'https://discord.com/api/webhooks/…', autocomplete: 'off' });
    const en = h('input', { type: 'checkbox', checked: cur ? cur.enabled : true });
    return h('div', { class: 'hook' }, h('b', {}, label, cur ? h('span', { class: 'tag ' + (cur.enabled ? 'ok' : 'gray'), style: 'margin-left:8px' }, cur.enabled ? 'включён' : 'выключен') : null), h('div', { class: 'row' }, h('div', { class: 'grow' }, url), h('label', { class: 'check' }, en, ' вкл'),
      h('button', { class: 'btn sm', type: 'button', onclick: safe(async () => {
        const v = url.value.trim();
        if (v) { if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/.test(v)) throw new Error('Это не адрес вебхука Discord'); ok(await sb.from('cp_webhooks').upsert({ event: ev, url: v, enabled: en.checked, updated_at: new Date().toISOString() })); }
        else if (cur) ok(await sb.from('cp_webhooks').update({ enabled: en.checked }).eq('event', ev)); else return;
        toast('Сохранено', 'ok'); rerender(); }) }, 'Сохранить'),
      cur ? h('button', { class: 'btn sm ghost', type: 'button', onclick: safe(async () => { const { error } = await sb.rpc('cp_test_webhook', { ev }); if (error) throw error; toast('Тест отправлен', 'ok'); }) }, 'Проверить') : null,
      cur ? h('button', { class: 'btn sm ghost', type: 'button', onclick: safe(async () => { if (!(await confirmDlg('Удалить вебхук?', 'Удалить', true))) return; ok(await sb.from('cp_webhooks').delete().eq('event', ev)); rerender(); }) }, '✕') : null));
  });

  return h('div', {}, h('h1', {}, 'Настройки'),
    card('Сайт', h('div', {}, field('Название', name), field('Подзаголовок', tag_), field('Подпись внизу', foot)), () => save('site', { name: name.value.trim(), tagline: tag_.value.trim(), footer: foot.value.trim() })),
    card('Суды и разделы форума', courtsBox, () => {
      const list = courts.filter((c) => c.code && c.name).map((c) => ({ ...c, server: c.server || (serverList(s)[0] || {}).code }));
      if (!list.length) throw new Error('Нужен хотя бы один суд');
      if (new Set(list.map((c) => c.code)).size !== list.length) throw new Error('Коды судов должны быть разными');
      if (list.some((c) => c.forum && !/^https?:\/\//i.test(c.forum))) throw new Error('Ссылка на форум должна начинаться с https://');
      return save('courts', list.map((c) => ({ code: c.code, server: c.server, name: c.name.trim(), forum: (c.forum || '').trim() })));
    }),
    card('Иски: категории и госпошлина', h('div', { class: 'grid2' }, field('Категории (по строке)', cats), field('Варианты госпошлины (по строке)', fees)), async () => { await save('claim_cats', lines(cats.value)); await save('fees', lines(fees.value)); }),
    card('Сроки', h('div', { class: 'grid3' }, field('Взять иск в работу, часов', d1), field('Ответ прокуратуры, часов', d2), field('Решение после начала, дней', d3)), () => save('deadlines', { start_h: +d1.value || 48, pros_h: +d2.value || 72, decide_d: +d3.value || 10 })),
    card('Приём на работу', h('div', {}, h('label', { class: 'check' }, open, ' Приём заявок открыт'), field('Должности (по строке)', pos), field('Вопросы анкеты (по строке)', qs)),
      async () => { await save('app_open', open.checked); await save('app_positions', lines(pos.value)); await save('app_questions', lines(qs.value)); }),
    card('Политика обработки данных', policy, () => save('policy', policy.value.trim())),
    h('div', { class: 'card' }, h('h3', {}, 'Уведомления в Discord'), h('p', { class: 'muted' }, 'Адрес вебхука хранится только в базе и после сохранения не показывается.'), hookRows));
}

// ------------------------------------------------------------------ журнал
export async function audit() {
  const rows = ok(await sb.from('cp_audit').select('*').order('at', { ascending: false }).limit(200)) || [];
  return h('div', {}, h('h1', {}, 'Журнал действий'), table([['Когда', (r) => fmtDate(r.at, true)], ['Кто', (r) => r.who || '—'], ['Действие', (r) => r.action], ['Раздел', (r) => r.tbl], ['Запись', (r) => r.target], ['Поля', (r) => (r.keys || []).join(', ')]], rows));
}
