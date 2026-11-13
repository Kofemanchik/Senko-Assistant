// Панель суда: обзор, реестр исков, карточка иска, заседания, решения по иску.
import { sb, h, errText, toast, modal, confirmDlg, field, input, textarea, select, copyText, stageTag, STAGE, OUTCOME, MATERIAL, MSTATUS, fmtDate, serverName } from '../assets/common.js';
import { state, is, COURT, JUDGES, LEAD, tag, ok, short, opts, table, overdueH, dtLocal, rerender, PROS_ST, srv, srvOrBoth, srvLabel } from './ui.js';

const dl = () => ({ start_h: 48, pros_h: 72, decide_d: 10, ...(state.settings.deadlines || {}) });
const late = (c) => {
  const d = dl();
  if (c.stage === 'new') return overdueH(c.created_at, d.start_h);
  if (['processing', 'hearing_held', 'decision'].includes(c.stage)) return overdueH(c.stage_at, d.decide_d * 24);
  return 0;
};

// ------------------------------------------------------------------- обзор
export async function dash() {
  const nowIso = new Date().toISOString();
  const week = new Date(Date.now() + 7 * 864e5).toISOString();
  const [open, hear, pros, apps] = await Promise.all([
    srv(sb.from('cp_claims').select('id,no,title,stage,stage_at,created_at,judge_id').neq('stage', 'closed').order('created_at').limit(300)),
    sb.from('cp_hearings').select('id,at,place,claim_id,cp_claims(no,title)').gte('at', nowIso).lte('at', week).order('at').limit(15),
    sb.from('cp_pros_requests').select('id,created_at,claim_id,cp_claims(no,title)').eq('status', 'pending').order('created_at').limit(50),
    is(...JUDGES) ? sb.from('cp_applications').select('id', { count: 'exact', head: true }).eq('status', 'new') : { count: null },
  ]);
  const claims = ok(open) || [];
  const hot = claims.filter((c) => late(c) > 0);
  const hotPros = (ok(pros) || []).filter((r) => overdueH(r.created_at, dl().pros_h) > 0);
  const stat = (n, l, href) => h('a', { class: 'card', href }, h('div', { class: 'stat' }, n ?? '—'), h('div', { class: 'stat-l' }, l));
  return h('div', {}, h('h1', {}, 'Обзор'),
    h('div', { class: 'cards stagger' },
      stat(claims.filter((c) => c.stage === 'new').length, 'Новых исков', '#/claims'),
      stat(claims.length, 'Исков в работе', '#/claims'),
      stat(hot.length + hotPros.length, 'Горящих сроков', '#/claims'),
      apps.count == null ? null : stat(apps.count, 'Новых заявок', '#/apps')),
    hot.length || hotPros.length ? h('div', {}, h('h2', { style: 'margin-top:24px' }, '🔥 Горящие сроки'),
      table([['Иск', (r) => `${r.no} ${short(r.title, 50)}`], ['Стадия', (r) => stageTag(r.stage, '')], ['Просрочка', (r) => h('span', { class: 'tag bad' }, late(r) + ' ч')]], hot, (r) => { location.hash = '#/claims/' + r.id; }),
      hotPros.length ? table([['Запрос к прокуратуре', (r) => r.cp_claims ? `${r.cp_claims.no} ${short(r.cp_claims.title, 40)}` : r.claim_id], ['Просрочка', (r) => h('span', { class: 'tag bad' }, overdueH(r.created_at, dl().pros_h) + ' ч')]], hotPros, (r) => { location.hash = '#/claims/' + r.claim_id; }) : null) : null,
    h('h2', { style: 'margin-top:24px' }, 'Заседания на неделю'),
    table([['Когда', (r) => fmtDate(r.at, true)], ['Иск', (r) => r.cp_claims ? `${r.cp_claims.no} ${short(r.cp_claims.title, 50)}` : '—'], ['Место', (r) => r.place || '—']], ok(hear) || [], (r) => { if (r.claim_id) location.hash = '#/claims/' + r.claim_id; }));
}

// -------------------------------------------------------------- реестр исков
export async function claims() {
  const box = h('div', {});
  const st = select([['open', 'Все открытые'], ['', 'Все'], ...opts(Object.fromEntries(Object.entries(STAGE)))], 'open', { 'aria-label': 'Стадия' });
  const mine = h('label', { class: 'check' }, h('input', { type: 'checkbox' }), ' Мои');
  const q = input({ type: 'search', placeholder: 'Номер, название или истец…', 'aria-label': 'Поиск' });
  async function load() {
    let req = srv(sb.from('cp_claims').select('id,no,title,plaintiff,court,server,stage,outcome,judge_id,stage_at,created_at,cp_profiles!cp_claims_judge_id_fkey(nick)').order('created_at', { ascending: false }).limit(300));
    if (st.value === 'open') req = req.neq('stage', 'closed'); else if (st.value) req = req.eq('stage', st.value);
    if (mine.querySelector('input').checked) req = req.eq('judge_id', state.me.id);
    const term = q.value.replace(/[%,()*\\]/g, ' ').trim();
    if (term) req = req.or(`no.ilike.%${term}%,title.ilike.%${term}%,plaintiff.ilike.%${term}%`);
    const rows = ok(await req);
    box.replaceChildren(table([
      ['№', (r) => r.no], ['Сервер', (r) => srvLabel(r.server)], ['Название', (r) => short(r.title, 60)], ['Истец', (r) => r.plaintiff], ['Стадия', (r) => stageTag(r.stage, r.outcome)],
      ['Судья', (r) => (r.cp_profiles && r.cp_profiles.nick) || '—'], ['Подан', (r) => fmtDate(r.created_at, true)],
      ['', (r) => late(r) ? h('span', { class: 'tag bad', title: 'Срок нарушен' }, '🔥 ' + late(r) + ' ч') : '']], rows, (r) => { location.hash = '#/claims/' + r.id; }, 'Исков нет.'));
  }
  st.onchange = load; mine.querySelector('input').onchange = load;
  q.addEventListener('input', (() => { let t; return () => { clearTimeout(t); t = setTimeout(load, 300); }; })());
  await load();
  return h('div', {}, h('h1', {}, 'Иски'), h('div', { class: 'toolbar' }, st, mine, h('div', { class: 'grow' }, q)), box);
}

// ----------------------------------------------------------- карточка иска
export async function claimCard([id]) {
  const c = ok(await sb.from('cp_claims').select('*').eq('id', id).maybeSingle());
  if (!c) return h('p', { class: 'empty' }, 'Иск не найден или нет доступа.');
  const canJudge = is(...JUDGES);
  const isLead = is(...LEAD);
  const mineOrFree = isLead || (state.me.role === 'judge' && (!c.judge_id || c.judge_id === state.me.id));
  const [mats, notes, hears, pros, judge, staff] = await Promise.all([
    sb.from('cp_materials').select('*').eq('claim_id', c.id).order('id'),
    canJudge ? sb.from('cp_claim_notes').select('*').eq('claim_id', c.id).order('id') : { data: [] },
    sb.from('cp_hearings').select('*').eq('claim_id', c.id).order('at'),
    sb.from('cp_pros_requests').select('*,pros:cp_profiles!cp_pros_requests_prosecutor_id_fkey(nick)').eq('claim_id', c.id).order('id'),
    c.judge_id ? sb.from('cp_profiles').select('nick').eq('id', c.judge_id).maybeSingle() : { data: null },
    isLead ? sb.from('cp_profiles').select('id,nick,role,server').in('role', ['admin', 'chair', 'judge']).or(`server.eq.${c.server},server.eq.`).order('nick') : { data: [] },
  ]);
  const upd = async (patch, msg = 'Сохранено') => { ok(await sb.from('cp_claims').update(patch).eq('id', c.id)); toast(msg, 'ok'); rerender(); };
  const safe = (fn) => async () => { try { await fn(); } catch (e) { toast(errText(e), 'err'); } };

  const kv = (k, v) => v ? [h('dt', {}, k), h('dd', {}, v)] : null;
  const info = h('div', { class: 'card' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0' }, `${c.no} · ${c.title}`), stageTag(c.stage, c.outcome)),
    h('dl', { class: 'kv', style: 'margin-top:12px' },
      kv('Сервер', serverName(state.settings, c.server)), kv('Суд', c.court_name), kv('Категория', c.category), kv('Подал', c.filer === 'lawyer' ? `Адвокат ${c.lawyer} (лицензия ${c.license})` : 'Гражданин'),
      kv('Истец', `${c.plaintiff} · статик ${c.plaintiff_static}`),
      kv('Ответчики', (c.defendants || []).map((d) => `${d.name}${d.static ? ' · статик ' + d.static : ''}${d.org ? ' · ' + d.org : ''}`).join('\n')),
      kv('Связанное дело', c.related_no), kv('Госпошлина', c.fee), kv('Контакты', c.contacts),
      kv('Подан', fmtDate(c.created_at, true)), kv('Судья', judge.data && judge.data.nick), kv('Обстоятельства', c.circumstances),
      kv('Требования', (c.requests || []).map((r, i) => `${i + 1}. ${r}`).join('\n'))),
    (c.attachments || []).length ? h('p', {}, h('b', {}, 'Приложения: '), (c.attachments).map((a) => [h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.name), ' '])) : null,
    h('div', { class: 'row' },
      c.forum_url ? h('a', { class: 'btn sm', href: c.forum_url, target: '_blank', rel: 'noopener noreferrer' }, 'Тема на форуме ↗') : h('span', { class: 'muted' }, 'Ссылка на форум не прикреплена'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(c.bb) }, 'Копировать BB-код')));

  // --- действия
  const actions = [];
  if (canJudge && !c.judge_id && c.stage !== 'closed') actions.push(h('button', { class: 'btn primary', type: 'button', onclick: safe(() => upd({ judge_id: state.me.id, ...(c.stage === 'new' ? { stage: 'processing' } : {}) }, 'Иск взят в работу')) }, 'Взять в работу'));
  if (isLead) {
    const sel = select([['', '— судья —'], ...staff.data.map((p) => [p.id, p.nick || p.id])], c.judge_id || '');
    actions.push(h('span', { class: 'row' }, sel, h('button', { class: 'btn', type: 'button', onclick: safe(() => upd({ judge_id: sel.value || null, ...(sel.value && c.stage === 'new' ? { stage: 'processing' } : {}) }, 'Судья назначен')) }, 'Назначить судью')));
  }
  if (mineOrFree && canJudge && c.stage !== 'closed') {
    const stg = select(opts(Object.fromEntries(Object.entries(STAGE).filter(([k]) => k !== 'closed'))), c.stage);
    actions.push(h('span', { class: 'row' }, stg, h('button', { class: 'btn', type: 'button', onclick: safe(() => upd({ stage: stg.value }, 'Стадия изменена')) }, 'Сменить стадию')));
    actions.push(h('button', { class: 'btn danger', type: 'button', onclick: () => closeDlg() }, 'Завершить иск'));
  }
  if (mineOrFree && canJudge && c.stage === 'closed') actions.push(h('button', { class: 'btn', type: 'button', onclick: safe(async () => { if (await confirmDlg('Вернуть иск в работу?')) await upd({ stage: 'processing', outcome: '' }); }) }, 'Вернуть в работу'));
  if (canJudge) actions.push(h('button', { class: 'btn', type: 'button', onclick: () => decisionDlg(c) }, 'Оформить решение'));

  function closeDlg() {
    const out = select(opts(OUTCOME), 'granted');
    const note = textarea({ rows: 4, maxlength: 1000, placeholder: 'Сообщение заявителю (будет видно по коду отслеживания)' }); note.value = c.public_note || '';
    modal({ title: 'Завершить иск', body: h('div', {}, field('Исход', out), field('Сообщение заявителю', note)), actions: [{ label: 'Отмена', value: false },
      { label: 'Завершить', kind: 'primary', run: async () => { ok(await sb.from('cp_claims').update({ stage: 'closed', outcome: out.value, public_note: note.value.trim(), decided_by: state.me.nick || state.me.login }).eq('id', c.id)); toast('Иск завершён', 'ok'); rerender(); } }] });
  }

  // --- заседания
  const hearBox = h('div', { class: 'card' }, h('h3', {}, 'Заседания'),
    (hears.data || []).length ? h('ul', { class: 'plain' }, hears.data.map((x) => h('li', {}, `${fmtDate(x.at, true)}${x.place ? ' · ' + x.place : ''}${x.note ? ' · ' + x.note : ''} `,
      mineOrFree ? h('button', { class: 'btn sm ghost', type: 'button', onclick: safe(async () => { if (!(await confirmDlg('Удалить заседание?', 'Удалить', true))) return; ok(await sb.from('cp_hearings').delete().eq('id', x.id)); rerender(); }) }, '✕') : null))) : h('p', { class: 'muted' }, 'Не назначены.'),
    mineOrFree && canJudge ? h('button', { class: 'btn sm', type: 'button', onclick: () => hearingDlg() }, '+ Назначить заседание') : null);

  function hearingDlg() {
    const at = input({ type: 'datetime-local', value: dtLocal(new Date(Date.now() + 86400e3)) });
    const place = input({ maxlength: 120, placeholder: 'Зал, канал Discord…' });
    const note = input({ maxlength: 200, placeholder: 'Примечание (необязательно)' });
    const warn = h('p', { class: 'muted' });
    const check = async () => {
      const t = new Date(at.value).getTime(); if (isNaN(t)) { warn.textContent = ''; return; }
      const from = new Date(t - 3600e3).toISOString(), to = new Date(t + 3600e3).toISOString();
      const { data } = await sb.from('cp_hearings').select('at,place,claim_id,cp_claims(no)').gte('at', from).lte('at', to);
      const other = (data || []).filter((x) => x.claim_id !== c.id);
      warn.textContent = other.length ? '⚠ В этот час уже есть заседания: ' + other.map((x) => `${fmtDate(x.at, true)} ${(x.cp_claims && x.cp_claims.no) || ''}`).join('; ') : '';
    };
    at.addEventListener('change', check); check();
    modal({ title: 'Назначить заседание', body: h('div', {}, field('Дата и время', at), warn, field('Место', place), field('Примечание', note)), actions: [{ label: 'Отмена', value: false },
      { label: 'Назначить', kind: 'primary', run: async () => {
        const t = new Date(at.value); if (isNaN(t)) { toast('Укажите дату и время', 'err'); return false; }
        ok(await sb.from('cp_hearings').insert({ claim_id: c.id, at: t.toISOString(), place: place.value.trim(), note: note.value.trim() }));
        if (['new', 'processing'].includes(c.stage)) await sb.from('cp_claims').update({ stage: 'hearing_set', ...(c.judge_id ? {} : { judge_id: state.me.id }) }).eq('id', c.id);
        toast('Заседание назначено', 'ok'); rerender(); } }] });
  }

  // --- материалы
  const matBox = h('div', { class: 'card' }, h('h3', {}, 'Материалы сторон'),
    (mats.data || []).length ? (mats.data).map((m) => h('div', { class: 'qa' },
      h('b', {}, `${MATERIAL[m.kind]} · ${fmtDate(m.created_at, true)} · `, tag(MSTATUS, m.status)),
      h('div', { style: 'white-space:pre-wrap' }, m.body),
      (m.links || []).length ? h('div', {}, (m.links).map((u) => [h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, u), h('br')])) : null,
      m.reason ? h('small', {}, 'Причина: ' + m.reason) : null,
      canJudge && m.status === 'pending' ? h('div', { class: 'row', style: 'margin-top:6px' },
        h('button', { class: 'btn sm primary', type: 'button', onclick: safe(async () => { ok(await sb.from('cp_materials').update({ status: 'accepted', decided_by: state.me.nick || '' }).eq('id', m.id)); rerender(); }) }, 'Принять'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: () => rejectDlg(m) }, 'Отклонить')) : null)) : h('p', { class: 'muted' }, 'Материалов нет.'));
  function rejectDlg(m) {
    const r = input({ maxlength: 300, placeholder: 'Причина отказа' });
    modal({ title: 'Отклонить материал', body: field('Причина', r), actions: [{ label: 'Отмена', value: false }, { label: 'Отклонить', kind: 'danger', run: async () => {
      ok(await sb.from('cp_materials').update({ status: 'rejected', reason: r.value.trim(), decided_by: state.me.nick || '' }).eq('id', m.id)); rerender(); } }] });
  }

  // --- прокуратура
  const activePros = (pros.data || []).find((r) => ['pending', 'assigned'].includes(r.status));
  const prosBox = h('div', { class: 'card' }, h('h3', {}, 'Прокурор'),
    (pros.data || []).length ? h('ul', { class: 'plain' }, pros.data.map((r) => h('li', {}, tag(PROS_ST, r.status), ` ${r.kind === 'replace' ? 'Замена' : 'Назначение'} · ${fmtDate(r.created_at, true)}`,
      r.pros && r.pros.nick ? ` · ${r.pros.nick}` : '', r.reason ? ` · отказ: ${r.reason}` : '', r.done_at ? ' · участие завершено' : ''))) : h('p', { class: 'muted' }, 'Запросов к прокуратуре не было.'),
    canJudge && c.stage !== 'closed' ? h('button', { class: 'btn sm', type: 'button', onclick: () => prosDlg() }, activePros && activePros.status === 'assigned' ? 'Запросить замену прокурора' : 'Запросить прокурора') : null);
  function prosDlg() {
    const replace = activePros && activePros.status === 'assigned';
    const note = textarea({ rows: 3, maxlength: 500, placeholder: 'Что нужно от прокурора (необязательно)' });
    modal({ title: replace ? 'Запрос замены прокурора' : 'Запрос прокурора', body: field('Комментарий', note), actions: [{ label: 'Отмена', value: false }, { label: 'Отправить', kind: 'primary', run: async () => {
      ok(await sb.from('cp_pros_requests').insert({ claim_id: c.id, kind: replace ? 'replace' : 'assign', note: note.value.trim(), requested_by: state.me.id, requested_name: state.me.nick || state.me.login }));
      toast('Запрос отправлен в прокуратуру', 'ok'); rerender(); } }] });
  }

  // --- заметки и ответ заявителю
  const noteIn = textarea({ rows: 3, maxlength: 2000, placeholder: 'Внутренняя заметка (заявитель её не видит)' });
  const pubIn = textarea({ rows: 3, maxlength: 1000, placeholder: 'Сообщение заявителю' }); pubIn.value = c.public_note || '';
  const notesBox = canJudge ? h('div', { class: 'card' }, h('h3', {}, 'Заметки суда'),
    (notes.data || []).map((n) => h('div', { class: 'qa' }, h('b', {}, `${n.author || '—'} · ${fmtDate(n.created_at, true)}`), n.body)),
    noteIn, h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn sm', type: 'button', onclick: safe(async () => {
      if (!noteIn.value.trim()) return;
      ok(await sb.from('cp_claim_notes').insert({ claim_id: c.id, author_id: state.me.id, author: state.me.nick || state.me.login, body: noteIn.value.trim() })); rerender(); }) }, 'Добавить заметку')),
    mineOrFree ? [h('h3', { style: 'margin-top:16px' }, 'Сообщение заявителю'), pubIn,
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn sm', type: 'button', onclick: safe(() => upd({ public_note: pubIn.value.trim() })) }, 'Сохранить'))] : null) : null;

  return h('div', {}, h('p', {}, h('a', { href: '#/claims' }, '← К списку исков')), info,
    actions.length ? h('div', { class: 'card' }, h('h3', {}, 'Действия'), h('div', { class: 'row' }, actions)) : null,
    h('div', { class: 'grid2' }, hearBox, prosBox), matBox, notesBox);
}

// ---------------------------------------------------------- решение по иску
function decisionDlg(c) {
  const title = input({ maxlength: 200, value: `Решение по иску ${c.no}: ${c.title}` });
  const no = input({ maxlength: 40, placeholder: 'Номер решения' });
  const verdict = input({ maxlength: 120, placeholder: 'Например: иск удовлетворён' });
  const person = input({ maxlength: 120, value: c.plaintiff });
  const text = textarea({ rows: 10, maxlength: 20000, placeholder: 'Текст решения' });
  const pub = h('input', { type: 'checkbox' }); const anon = h('input', { type: 'checkbox', checked: true });
  modal({ title: 'Оформить решение', wide: true, body: h('div', {}, field('Заголовок', title), h('div', { class: 'grid2' }, field('Номер', no), field('Вердикт', verdict)), field('Лицо', person), field('Текст', text),
    h('label', { class: 'check' }, pub, ' Опубликовать в реестре решений'), h('label', { class: 'check' }, anon, ' Скрыть имя лица в публикации')),
  actions: [{ label: 'Отмена', value: false }, { label: 'Сохранить', kind: 'primary', run: async () => {
    if (title.value.trim().length < 3 || text.value.trim().length < 10) { toast('Заполните заголовок и текст', 'err'); return false; }
    ok(await sb.from('cp_decisions').insert({ claim_id: c.id, title: title.value.trim(), no: no.value.trim(), verdict: verdict.value.trim(), person: person.value.trim(), text: text.value.trim(), public: pub.checked, anon: anon.checked, author: state.me.nick || state.me.login }));
    if (c.stage !== 'closed' && c.stage !== 'decision') await sb.from('cp_claims').update({ stage: 'decision' }).eq('id', c.id);
    toast('Решение сохранено', 'ok'); rerender(); } }] });
}

// ------------------------------------------------------ заседания (общий список)
export async function hearings() {
  const from = new Date(Date.now() - 2 * 864e5).toISOString();
  const rows = ok(await sb.from('cp_hearings').select('id,at,place,note,claim_id,case_id,cp_claims(no,title,court_name),cp_cases(no,title)').gte('at', from).order('at').limit(300)) || [];
  const now = Date.now();
  const clash = new Set();
  rows.forEach((a, i) => rows.forEach((b, j) => { if (i < j && Math.abs(new Date(a.at) - new Date(b.at)) < 3600e3) { clash.add(a.id); clash.add(b.id); } }));
  const label = (r) => r.cp_claims ? `${r.cp_claims.no} ${short(r.cp_claims.title, 45)}` : r.cp_cases ? `Дело ${r.cp_cases.no || r.case_id} ${short(r.cp_cases.title, 40)}` : '—';
  return h('div', {}, h('h1', {}, 'Заседания'),
    h('p', { class: 'muted' }, 'Назначаются из карточки иска или дела. ⚠ — заседания пересекаются по времени (меньше часа между ними).'),
    table([['Когда', (r) => [fmtDate(r.at, true), clash.has(r.id) ? ' ⚠' : '']], ['Иск или дело', label], ['Место', (r) => r.place || '—'], ['', (r) => new Date(r.at) < now ? h('span', { class: 'tag gray' }, 'прошло') : '']],
      rows, (r) => { location.hash = r.claim_id ? '#/claims/' + r.claim_id : '#/cases/' + r.case_id; }));
}
