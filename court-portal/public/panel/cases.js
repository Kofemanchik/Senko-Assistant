// Дела суда, IID и прокуратуры с передачей между ведомствами, а также работа прокуратуры с запросами суда.
import { sb, h, errText, toast, modal, confirmDlg, field, input, textarea, select, stageTag, fmtDate, serverList } from '../assets/common.js';
import { state, is, COURT, JUDGES, HOLDER, FLOW, CASE_ST, CASE_KIND, PROS_ST, tag, ok, short, opts, table, dtLocal, rerender, srv, srvLabel } from './ui.js';

const role = () => state.me.role;
const myOrg = () => (COURT.includes(role()) ? 'court' : ['iid', 'iid_head'].includes(role()) ? 'iid' : 'prosecutor');
const safe = (fn) => async () => { try { await fn(); } catch (e) { toast(errText(e), 'err'); } };
const ACT = { submit: 'Отправлено на проверку', approve: 'Утверждено', send_back: 'Возвращено на доработку', reject: 'Отклонено', unapprove: 'Утверждение снято', transfer: 'Дело передано', return: 'Дело возвращено' };

// права на действия: повторяют проверки базы, чтобы показывать только доступные кнопки (решает всё равно база)
function perms(c) {
  const r = role();
  const head = r === 'admin' || (c.holder === 'iid' && r === 'iid_head') || (c.holder === 'prosecutor' && r === 'prosecutor_head');
  const own = head || (c.created_by === state.me.id && ((c.holder === 'iid' && ['iid', 'iid_head'].includes(r)) || (c.holder === 'prosecutor' && ['prosecutor', 'prosecutor_head'].includes(r))));
  const court = c.holder === 'court';
  return {
    head, own,
    edit: r === 'admin' || (court && COURT.includes(r)) || (!court && own && ['draft', 'returned'].includes(c.flow)),
    submit: !court && own && ['draft', 'returned'].includes(c.flow),
    approve: head && c.flow === 'review', unapprove: !court && own && c.flow === 'approved',
    transfer: !court && own && (c.flow === 'approved' || (c.flow === 'transferred' && head)),
    back: c.flow === 'transferred' && !!c.from_holder && ((court && JUDGES.includes(r)) || (c.holder === 'prosecutor' && ['admin', 'prosecutor', 'prosecutor_head'].includes(r))),
  };
}

// ------------------------------------------------------------------- список
export async function cases() {
  const box = h('div', {});
  const flow = select([['', 'Любой статус'], ...Object.entries(FLOW).map(([k, v]) => [k, v[0]])], '');
  const holder = select([['', 'Все ведомства'], ...Object.entries(HOLDER)], '');
  const q = input({ type: 'search', placeholder: 'Номер, название, обвиняемый…' });
  async function load() {
    let req = srv(sb.from('cp_cases').select('id,no,title,kind,holder,org,server,flow,accused,updated_at').order('updated_at', { ascending: false }).limit(300));
    if (flow.value) req = req.eq('flow', flow.value); if (holder.value) req = req.eq('holder', holder.value);
    const term = q.value.replace(/[%,()*\\]/g, ' ').trim();
    if (term) req = req.or(`no.ilike.%${term}%,title.ilike.%${term}%,accused.ilike.%${term}%`);
    box.replaceChildren(table([['№', (r) => r.no || '№' + r.id], ['Сервер', (r) => srvLabel(r.server)], ['Название', (r) => short(r.title, 60)], ['Обвиняемый', (r) => r.accused || '—'], ['Вид', (r) => CASE_KIND[r.kind]],
      ['Где дело', (r) => HOLDER[r.holder]], ['Статус', (r) => tag(FLOW, r.flow)], ['Обновлено', (r) => fmtDate(r.updated_at, true)]], ok(await req), (r) => { location.hash = '#/cases/' + r.id; }, 'Дел нет.'));
  }
  [flow, holder].forEach((s) => (s.onchange = load));
  q.addEventListener('input', (() => { let t; return () => { clearTimeout(t); t = setTimeout(load, 300); }; })());
  await load();
  return h('div', {}, h('div', { class: 'row', style: 'justify-content:space-between' }, h('h1', {}, 'Дела'), h('button', { class: 'btn primary', type: 'button', onclick: () => caseForm(null) }, '+ Новое дело')),
    h('div', { class: 'toolbar' }, flow, holder, h('div', { class: 'grow' }, q)), box);
}

// -------------------------------------------------------------- форма дела
function caseForm(c) {
  const isNew = !c;
  const org = isNew ? (is('admin') ? null : myOrg()) : c.org;
  const orgSel = isNew && is('admin') ? select(Object.entries(HOLDER), 'court') : null;
  const srvSel = isNew && is('admin') ? select(serverList(state.settings).map((x) => [x.code, x.name]), state.server || (serverList(state.settings)[0] || {}).code) : null;
  const f = {
    no: input({ maxlength: 40, value: c ? c.no : '', placeholder: 'Оставьте пустым для автонумерации' }),
    title: input({ maxlength: 200, value: c ? c.title : '' }),
    kind: select(Object.entries(CASE_KIND), c ? c.kind : 'criminal'),
    accused: input({ maxlength: 200, value: c ? c.accused : '', placeholder: 'Имя Фамилия, статик' }),
    articles: input({ maxlength: 300, value: c ? c.articles : '', placeholder: 'Статьи, например УК ст. 12' }),
    parties: textarea({ rows: 3, placeholder: 'По строке: роль: имя (потерпевший: Иван Иванов)' }),
    progress: textarea({ rows: 5, maxlength: 8000, placeholder: 'Ход дела: что сделано, какие доказательства собраны' }),
    notes: textarea({ rows: 3, maxlength: 4000 }),
    mats: textarea({ rows: 3, placeholder: 'По строке: название | https://ссылка' }),
  };
  if (c) {
    f.parties.value = (c.parties || []).map((p) => `${p.role}: ${p.name}`).join('\n');
    f.progress.value = c.progress || ''; f.notes.value = c.notes || '';
    f.mats.value = (c.materials || []).map((m) => `${m.name} | ${m.url}`).join('\n');
  }
  const parse = () => {
    const parties = f.parties.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(':'); return i > 0 ? { role: l.slice(0, i).trim(), name: l.slice(i + 1).trim() } : { role: '', name: l }; });
    const materials = f.mats.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.lastIndexOf('|'); return i > 0 ? { name: l.slice(0, i).trim(), url: l.slice(i + 1).trim() } : { name: l, url: '' }; });
    if (materials.some((m) => m.url && !/^https?:\/\//i.test(m.url))) throw new Error('bad_url');
    return { parties, materials };
  };
  modal({ title: isNew ? 'Новое дело' : 'Редактировать дело', wide: true,
    body: h('div', {}, orgSel ? h('div', { class: 'grid2' }, field('Ведомство', orgSel), field('Сервер', srvSel)) : null, h('div', { class: 'grid2' }, field('Номер', f.no), field('Вид', f.kind)), field('Название', f.title),
      h('div', { class: 'grid2' }, field('Обвиняемый', f.accused), field('Статьи', f.articles)), field('Стороны', f.parties), field('Материалы', f.mats), field('Ход дела', f.progress), field('Заметки', f.notes)),
    actions: [{ label: 'Отмена', value: false }, { label: 'Сохранить', kind: 'primary', run: async () => {
      if (f.title.value.trim().length < 3) { toast('Укажите название дела', 'err'); return false; }
      const { parties, materials } = parse();
      const base = { title: f.title.value.trim(), kind: f.kind.value, accused: f.accused.value.trim(), articles: f.articles.value.trim(), parties, materials, progress: f.progress.value.trim(), notes: f.notes.value.trim() };
      if (isNew) {
        const o = orgSel ? orgSel.value : org;
        const row = { ...base, org: o, holder: o, ...(srvSel ? { server: srvSel.value } : {}), flow: o === 'court' ? 'approved' : 'draft', created_by: state.me.id, ...(f.no.value.trim() ? { no: f.no.value.trim() } : {}) };
        const d = ok(await sb.from('cp_cases').insert(row).select().single());
        toast('Дело создано', 'ok'); location.hash = '#/cases/' + d.id; rerender();
      } else { ok(await sb.from('cp_cases').update({ ...base, ...(c.holder === 'court' && f.no.value.trim() ? { no: f.no.value.trim() } : {}) }).eq('id', c.id)); toast('Сохранено', 'ok'); rerender(); }
    } }] });
}

// ------------------------------------------------------------ карточка дела
export async function caseCard([id]) {
  const c = ok(await sb.from('cp_cases').select('*').eq('id', id).maybeSingle());
  if (!c) return h('p', { class: 'empty' }, 'Дело не найдено или нет доступа.');
  const [log, hears] = await Promise.all([
    sb.from('cp_case_log').select('*').eq('case_id', c.id).order('at'),
    c.holder === 'court' && COURT.includes(role()) ? sb.from('cp_hearings').select('*').eq('case_id', c.id).order('at') : { data: [] },
  ]);
  const p = perms(c);
  const act = async (a, needNote) => {
    let note = '';
    if (needNote) {
      const n = textarea({ rows: 3, maxlength: 1000, placeholder: 'Причина или комментарий' });
      const res = await modal({ title: ACT[a], body: field('Комментарий', n), actions: [{ label: 'Отмена', value: false }, { label: 'Подтвердить', kind: 'primary', value: true }] });
      if (res !== true) return; note = n.value.trim();
    } else if (!(await confirmDlg(ACT[a] + '?'))) return;
    const { error } = await sb.rpc('cp_case_action', { cid: c.id, act: a, note });
    if (error) return toast(errText(error), 'err');
    toast(ACT[a], 'ok'); rerender();
  };
  const btns = [];
  if (p.submit) btns.push(h('button', { class: 'btn primary', type: 'button', onclick: () => act('submit') }, 'Отправить на проверку'));
  if (p.approve) btns.push(h('button', { class: 'btn primary', type: 'button', onclick: () => act('approve') }, 'Утвердить'), h('button', { class: 'btn', type: 'button', onclick: () => act('send_back', true) }, 'Вернуть на доработку'), h('button', { class: 'btn danger', type: 'button', onclick: () => act('reject', true) }, 'Отклонить'));
  if (p.transfer) btns.push(h('button', { class: 'btn primary', type: 'button', onclick: () => act('transfer') }, c.holder === 'iid' ? 'Передать в прокуратуру' : 'Передать в суд'));
  if (p.back) btns.push(h('button', { class: 'btn', type: 'button', onclick: () => act('return', true) }, 'Вернуть отправителю'));
  if (p.unapprove) btns.push(h('button', { class: 'btn ghost', type: 'button', onclick: () => act('unapprove') }, 'Снять утверждение'));
  if (p.edit) btns.push(h('button', { class: 'btn', type: 'button', onclick: () => caseForm(c) }, 'Редактировать'));
  if (c.holder === 'court' && COURT.includes(role())) {
    const st = select(Object.entries(CASE_ST), c.status);
    btns.push(h('span', { class: 'row' }, st, h('button', { class: 'btn', type: 'button', onclick: safe(async () => { ok(await sb.from('cp_cases').update({ status: st.value, ...(st.value === 'closed' ? { closed_at: new Date().toISOString() } : { closed_at: null }) }).eq('id', c.id)); toast('Статус изменён', 'ok'); rerender(); }) }, 'Сменить статус')));
  }
  if (is('admin')) btns.push(h('button', { class: 'btn danger ghost', type: 'button', onclick: safe(async () => { if (!(await confirmDlg('Удалить дело безвозвратно?', 'Удалить', true))) return; ok(await sb.from('cp_cases').delete().eq('id', c.id)); location.hash = '#/cases'; }) }, 'Удалить'));
  const kv = (k, v) => v ? [h('dt', {}, k), h('dd', {}, v)] : null;
  const hearBox = c.holder === 'court' && COURT.includes(role()) ? h('div', { class: 'card' }, h('h3', {}, 'Заседания'),
    (hears.data || []).length ? h('ul', { class: 'plain' }, hears.data.map((x) => h('li', {}, `${fmtDate(x.at, true)}${x.place ? ' · ' + x.place : ''} `, h('button', { class: 'btn sm ghost', type: 'button', onclick: safe(async () => { ok(await sb.from('cp_hearings').delete().eq('id', x.id)); rerender(); }) }, '✕')))) : h('p', { class: 'muted' }, 'Не назначены.'),
    h('button', { class: 'btn sm', type: 'button', onclick: () => {
      const at = input({ type: 'datetime-local', value: dtLocal(new Date(Date.now() + 86400e3)) }); const place = input({ maxlength: 120, placeholder: 'Место' });
      modal({ title: 'Назначить заседание', body: h('div', {}, field('Дата и время', at), field('Место', place)), actions: [{ label: 'Отмена', value: false }, { label: 'Назначить', kind: 'primary', run: async () => {
        const t = new Date(at.value); if (isNaN(t)) { toast('Укажите дату', 'err'); return false; }
        ok(await sb.from('cp_hearings').insert({ case_id: c.id, at: t.toISOString(), place: place.value.trim() })); rerender(); } }] });
    } }, '+ Назначить заседание')) : null;
  return h('div', {}, h('p', {}, h('a', { href: '#/cases' }, '← К списку дел')),
    h('div', { class: 'card' }, h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0' }, `${c.no || '№' + c.id} · ${c.title}`), tag(FLOW, c.flow)),
      h('dl', { class: 'kv', style: 'margin-top:12px' }, kv('Где дело', HOLDER[c.holder] + (c.from_holder ? ` (пришло из: ${HOLDER[c.from_holder]})` : '')), kv('Вид', CASE_KIND[c.kind]), kv('Статус', CASE_ST[c.status]), kv('Обвиняемый', c.accused), kv('Статьи', c.articles),
        kv('Стороны', (c.parties || []).map((x) => `${x.role ? x.role + ': ' : ''}${x.name}`).join('\n')), kv('Утвердил', c.approved_by), kv('Причина возврата', c.return_reason), kv('Ход дела', c.progress), kv('Заметки', c.notes)),
      (c.materials || []).length ? h('p', {}, h('b', {}, 'Материалы: '), c.materials.map((m) => [m.url ? h('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer' }, m.name) : m.name, ' '])) : null),
    btns.length ? h('div', { class: 'card' }, h('h3', {}, 'Действия'), h('div', { class: 'row' }, btns)) : null, hearBox,
    h('div', { class: 'card' }, h('h3', {}, 'Движение дела'), (log.data || []).length ? h('ul', { class: 'plain' }, log.data.map((l) => h('li', {}, `${fmtDate(l.at, true)} · ${ACT[l.action] || l.action} · ${l.who}`, l.to_holder && l.from_holder !== l.to_holder ? ` · ${HOLDER[l.from_holder]} → ${HOLDER[l.to_holder]}` : '', l.note ? ` · «${l.note}»` : ''))) : h('p', { class: 'muted' }, 'Записей пока нет.')));
}

// -------------------------------------------------------- прокуратура: запросы
export async function prosecution() {
  const head = is('admin', 'prosecutor_head');
  const rows = ok(await sb.from('cp_pros_requests').select('*,cp_claims(no,title,court_name),pros:cp_profiles!cp_pros_requests_prosecutor_id_fkey(nick)').order('created_at', { ascending: false }).limit(200)) || [];
  const mine = !head ? rows.filter((r) => r.prosecutor_id === state.me.id) : rows;
  let staff = [];
  if (head) staff = ok(await sb.from('cp_profiles').select('id,nick,role').in('role', ['prosecutor', 'prosecutor_head']).order('nick')) || [];
  const handle = (r) => {
    const who = select([['', '— прокурор —'], ...staff.map((s) => [s.id, s.nick || s.id])], r.prosecutor_id || '');
    const reason = input({ maxlength: 300, placeholder: 'Причина отказа (если отказываете)' });
    modal({ title: `Запрос по иску ${r.cp_claims ? r.cp_claims.no : r.claim_id}`, body: h('div', {}, r.note ? h('p', {}, 'Комментарий суда: ' + r.note) : null, field('Назначить', who), field('Отказ', reason)),
      actions: [{ label: 'Закрыть', value: false },
        { label: 'Отказать', kind: 'danger', run: async () => { if (!reason.value.trim()) { toast('Укажите причину отказа', 'err'); return false; } ok(await sb.from('cp_pros_requests').update({ status: 'declined', reason: reason.value.trim(), handled_by: state.me.nick || '', handled_at: new Date().toISOString() }).eq('id', r.id)); rerender(); } },
        { label: 'Назначить', kind: 'primary', run: async () => { if (!who.value) { toast('Выберите прокурора', 'err'); return false; } ok(await sb.from('cp_pros_requests').update({ status: 'assigned', prosecutor_id: who.value, reason: '', handled_by: state.me.nick || '', handled_at: new Date().toISOString() }).eq('id', r.id)); toast('Прокурор назначен', 'ok'); rerender(); } }] });
  };
  return h('div', {}, h('h1', {}, head ? 'Запросы суда' : 'Мои назначения'),
    table([['Иск', (r) => r.cp_claims ? `${r.cp_claims.no} ${short(r.cp_claims.title, 45)}` : r.claim_id], ['Тип', (r) => (r.kind === 'replace' ? 'Замена' : 'Назначение')], ['Статус', (r) => tag(PROS_ST, r.status)],
      ['Прокурор', (r) => (r.pros && r.pros.nick) || '—'], ['От', (r) => r.requested_name || '—'], ['Когда', (r) => fmtDate(r.created_at, true)],
      ['', (r) => head && r.status === 'pending' ? h('button', { class: 'btn sm primary', type: 'button', onclick: (e) => { e.stopPropagation(); handle(r); } }, 'Разобрать')
        : r.status === 'assigned' && r.prosecutor_id === state.me.id && !r.done_at ? h('button', { class: 'btn sm', type: 'button', onclick: (e) => { e.stopPropagation(); safe(async () => { if (!(await confirmDlg('Отметить участие завершённым?'))) return; ok(await sb.from('cp_pros_requests').update({ done_at: new Date().toISOString() }).eq('id', r.id)); rerender(); })(); } }, 'Участие завершено')
        : r.done_at ? h('span', { class: 'tag gray' }, 'завершено') : '']],
    mine, (r) => { location.hash = '#/claims/' + r.claim_id; }, head ? 'Запросов нет.' : 'Вас пока не назначали на иски.'));
}
