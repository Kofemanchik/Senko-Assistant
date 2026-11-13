// Публичный сайт: главная, подача иска, статус, заседания, законы, решения, гайд, заявки, кабинет.
import { sb, configured, h, $, fmtDate, errText, toast, modal, confirmDlg, field, input, textarea, select, debounce, copyText, initTheme, setupNotice,
  toEmail, loginOk, isUrl, stageTag, MATERIAL, MSTATUS, SERVER_KEY, serverList, currentServer, serverName } from './common.js';
import { claimPage, FORUM_GUIDE } from './claim.js';

const view = $('#view');
const spinner = () => h('div', { class: 'bar-spin' });
let settings = {};
let me = null; // { id, profile, chars }
let server = '';
const courtsOf = () => (Array.isArray(settings.courts) ? settings.courts : []).filter((c) => c && c.code && c.server === server);
const srvTag = (code) => h('span', { class: 'tag gray' }, serverName(settings, code));

async function loadSettings() {
  const { data } = await sb.from('cp_settings').select('key,value');
  settings = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  const site = settings.site || {};
  $('#siteName').textContent = site.name || 'Судебный портал';
  document.title = site.name || 'Судебный портал';
  $('#siteFooter').textContent = site.footer || '';
  server = currentServer(settings);
  const sel = $('#srvSel'); const list = serverList(settings);
  sel.replaceChildren(...list.map((x) => h('option', { value: x.code }, x.name)));
  sel.value = server; sel.hidden = list.length < 2;
  sel.onchange = () => { server = sel.value; try { localStorage.setItem(SERVER_KEY, server); } catch {} render(); };
}

async function loadMe() {
  const { data: s } = await sb.auth.getSession();
  const uid = s && s.session && s.session.user && s.session.user.id;
  if (!uid) { me = null; } else {
    const [{ data: profile }, { data: chars }] = await Promise.all([
      sb.from('cp_profiles').select('*').eq('id', uid).maybeSingle(),
      sb.from('cp_characters').select('*').eq('user_id', uid).order('id'),
    ]);
    me = { id: uid, profile: profile || {}, chars: chars || [] };
  }
  $('#navAcc').textContent = me ? (me.profile.nick || me.profile.login || 'Кабинет') : 'Войти';
}

const card = (href, t, d) => h('a', { class: 'card', href }, h('h3', {}, t), h('p', { class: 'muted' }, d));
const STAFF = ['admin', 'chair', 'judge', 'clerk', 'prosecutor', 'prosecutor_head', 'iid', 'iid_head'];

// ------------------------------------------------------------------ главная
function home() {
  const site = settings.site || {};
  const open = settings.app_open === true;
  return h('div', {},
    h('section', { class: 'hero' }, h('h1', {}, site.name || 'Судебный портал'), h('p', {}, site.tagline || ''), server ? h('p', { class: 'muted' }, 'Сервер: ', h('b', {}, serverName(settings, server)), ' — переключатель вверху страницы.') : null,
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/claim' }, 'Подать иск'), h('a', { class: 'btn', href: '#/track' }, 'Узнать статус'))),
    h('div', { class: 'cards stagger' },
      card('#/claim', '📝 Подать иск', 'Заполните три шага — сайт соберёт готовый BB-код для форума и подскажет, как его вставить.'),
      card('#/track', '🔎 Статус иска', 'По номеру или коду отслеживания: стадия, судья, заседание.'),
      card('#/hearings', '🗓 Заседания', 'Расписание ближайших судебных заседаний.'),
      card('#/laws', '📚 Законы и кодексы', 'Поиск по статьям и кодексам.'),
      card('#/decisions', '⚖ Решения суда', 'Реестр опубликованных решений.'),
      card('#/cabinet', '👤 Кабинет', 'Ваши иски, персонажи и материалы по делам в одном месте.'),
      card('#/apply', '💼 Работа в суде', open ? 'Приём заявок открыт: подайте анкету.' : 'Приём заявок сейчас закрыт.')));
}

// ------------------------------------------------------------------- законы
async function laws() {
  const list = h('div', { class: 'stagger' });
  const q = input({ type: 'search', placeholder: 'Поиск по статье, названию или тексту…', 'aria-label': 'Поиск' });
  const code = select([['', 'Все кодексы']], '');
  const info = h('p', { class: 'muted' });
  const { data: codes } = await sb.from('cp_laws').select('code').or(`server.eq.${server},server.eq.`).limit(10000);
  [...new Set((codes || []).map((r) => r.code))].sort().forEach((c) => code.append(h('option', { value: c }, c)));
  async function run() {
    const term = q.value.replace(/[%,()*\\]/g, ' ').trim();
    let req = sb.from('cp_laws').select('id,code,article,title,body').order('code').order('sort').order('article').limit(100);
    if (server) req = req.or(`server.eq.${server},server.eq.`);
    if (code.value) req = req.eq('code', code.value);
    if (term) req = req.or(`title.ilike.%${term}%,body.ilike.%${term}%,article.ilike.${term}%`);
    const { data, error } = await req;
    if (error) { list.replaceChildren(h('p', { class: 'empty' }, errText(error))); return; }
    info.textContent = data.length === 100 ? 'Показаны первые 100 результатов. Уточните запрос.' : '';
    list.replaceChildren(...(data.length ? data.map((l) => h('details', { class: 'law' },
      h('summary', {}, `${l.code}, ст. ${l.article}${l.title ? ' — ' + l.title : ''}`),
      h('div', { class: 'law-b' }, l.body || 'Текст статьи не добавлен.'))) : [h('p', { class: 'empty' }, 'Ничего не найдено.')]));
  }
  q.addEventListener('input', debounce(run, 300)); code.addEventListener('change', run);
  run();
  return h('div', {}, h('h1', {}, 'Законы и кодексы'), h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, q), h('div', {}, code)), info, list);
}

// ------------------------------------------------------------------ решения
async function decisions() {
  const list = h('div', { class: 'stagger' });
  const q = input({ type: 'search', placeholder: 'Поиск по названию или тексту решения…', 'aria-label': 'Поиск' });
  async function run() {
    const term = q.value.replace(/[%,()*\\]/g, ' ').trim();
    let req = sb.from('cp_decisions_public').select('*').eq('server', server).order('dt', { ascending: false }).limit(100);
    if (term) req = req.or(`title.ilike.%${term}%,text.ilike.%${term}%`);
    const { data, error } = await req;
    if (error) { list.replaceChildren(h('p', { class: 'empty' }, errText(error))); return; }
    list.replaceChildren(...(data.length ? data.map((d) => h('details', { class: 'law' },
      h('summary', {}, `${d.no ? '№ ' + d.no + ' · ' : ''}${d.title}`, h('br'), h('small', {}, fmtDate(d.dt) + (d.verdict ? ' · ' + d.verdict : '') + (d.person ? ' · ' + d.person : ''))),
      h('div', { class: 'law-b' }, d.text))) : [h('p', { class: 'empty' }, term ? 'Ничего не найдено.' : 'Опубликованных решений пока нет.')]));
  }
  q.addEventListener('input', debounce(run, 300)); run();
  return h('div', {}, h('h1', {}, 'Решения суда'), h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, q)), list);
}

// ---------------------------------------------------------------- заседания
async function hearings() {
  const { data, error } = await sb.from('cp_hearings_public').select('*').eq('server', server).order('at');
  if (error) return h('p', { class: 'empty' }, errText(error));
  const now = Date.now();
  const rows = data || [];
  const up = rows.filter((x) => new Date(x.at) >= now - 2 * 3600e3);
  const past = rows.filter((x) => !up.includes(x));
  const tbl = (arr) => h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Когда', 'Иск', 'Суд', 'Где'].map((c) => h('th', {}, c)))),
    h('tbody', {}, arr.map((x) => h('tr', { class: 'click', onclick: () => { location.hash = '#/track/' + x.no; } }, h('td', {}, fmtDate(x.at, true)), h('td', {}, x.no), h('td', {}, x.court), h('td', {}, x.place || '—'))))));
  return h('div', {}, h('h1', {}, 'Заседания'),
    up.length ? tbl(up) : h('p', { class: 'empty' }, 'Назначенных заседаний пока нет.'),
    past.length ? [h('h3', { style: 'margin-top:20px' }, 'Недавно прошли'), tbl(past)] : null);
}

// -------------------------------------------------------------------- гайд
function guide() {
  const courts = courtsOf();
  const dl = settings.deadlines || {};
  return h('div', {}, h('h1', {}, 'Как подать иск'),
    h('div', { class: 'card' }, h('h3', {}, '1. Заполните иск на сайте'), h('p', {}, 'Откройте «Подать иск», пройдите три шага. Черновик сохраняется, можно вернуться позже.')),
    h('div', { class: 'card' }, h('h3', {}, '2. Опубликуйте иск на форуме'), FORUM_GUIDE(courts[0] && courts[0].forum),
      courts.filter((c) => c.forum).length > 1 ? h('p', { class: 'muted' }, 'Разделы форума: ', courts.filter((c) => c.forum).map((c) => [h('a', { href: c.forum, target: '_blank', rel: 'noopener noreferrer' }, c.name), ' '])) : null),
    h('div', { class: 'card' }, h('h3', {}, '3. Следите за статусом'),
      h('p', {}, 'Сохраните код отслеживания. На странице «Статус» видно стадию, судью и заседание. Ходатайства и доказательства отправляются там же.'),
      dl.start_h ? h('p', { class: 'muted' }, `Суд берёт иск в работу в течение ${dl.start_h} ч.`) : null),
    h('div', { class: 'card' }, h('h3', {}, 'Стадии иска'),
      h('p', {}, ['new', 'processing', 'prosecutor', 'hearing_set', 'hearing_held', 'decision', 'closed'].map((s) => [stageTag(s, ''), ' '])),
      h('p', { class: 'muted' }, 'Если иск касается сотрудников государственных органов, к делу может быть назначен прокурор.')),
    h('p', {}, h('a', { class: 'btn primary', href: '#/claim' }, 'Перейти к подаче иска')));
}

// ----------------------------------------------------------------- заявки
function apply() {
  const open = settings.app_open === true;
  const positions = Array.isArray(settings.app_positions) ? settings.app_positions : [];
  const questions = Array.isArray(settings.app_questions) ? settings.app_questions : [];
  if (!open) return h('div', {}, h('h1', {}, 'Работа в судебной системе'), h('div', { class: 'card' }, h('p', {}, 'Приём заявок сейчас закрыт. Загляните позже.')));
  const nick = input({ maxlength: 60, placeholder: 'Имя Фамилия' });
  const dc = input({ maxlength: 60, placeholder: 'ник или ссылка' });
  const pos = select(positions, positions[0]);
  const qs = questions.map((q) => ({ q, el: textarea({ rows: 3, maxlength: 2000 }) }));
  const btn = h('button', { class: 'btn primary', type: 'button' }, 'Отправить заявку');
  btn.onclick = async () => {
    if (nick.value.trim().length < 2 || dc.value.trim().length < 2) return toast('Укажите ник и Discord', 'err');
    if (qs.some((x) => !x.el.value.trim())) return toast('Ответьте на все вопросы', 'err');
    btn.disabled = true;
    const { data, error } = await sb.rpc('cp_submit_application', { p: { server, nickname: nick.value, discord: dc.value, position: pos.value, answers: qs.map((x) => ({ q: x.q, a: x.el.value })) } });
    btn.disabled = false;
    if (error) return toast(errText(error), 'err');
    view.replaceChildren(h('div', { class: 'card view' }, h('h2', {}, 'Заявка отправлена'), h('p', {}, `Номер вашей заявки: ${data}. Ответ придёт в Discord.`)));
  };
  return h('div', {}, h('h1', {}, 'Работа в судебной системе'), h('p', { class: 'muted' }, 'Сервер: ', serverName(settings, server)),
    h('div', { class: 'card' }, h('div', { class: 'grid2' }, field('Ник в игре', nick), field('Discord', dc)), field('Должность', pos), qs.map((x) => field(x.q, x.el)), btn));
}

// ------------------------------------------------------------ статус иска
function sendMaterialDialog(code, after) {
  const kind = select(Object.entries(MATERIAL), 'motion');
  const body = textarea({ rows: 6, maxlength: 4000, placeholder: 'Текст ходатайства, отзыва или описание доказательств' });
  const links = textarea({ rows: 3, placeholder: 'Ссылки на файлы, по одной в строке' });
  return modal({ title: 'Отправить материал в суд', wide: true,
    body: h('div', {}, field('Тип', kind), field('Текст', body, 'От 5 знаков.'), field('Ссылки (необязательно)', links)),
    actions: [{ label: 'Отмена', value: false }, { label: 'Отправить', kind: 'primary', run: async () => {
      const ls = links.value.split('\n').map((x) => x.trim()).filter(Boolean);
      if (ls.some((u) => !isUrl(u))) { toast('Каждая ссылка должна начинаться с http:// или https://', 'err'); return false; }
      const { error } = await sb.rpc('cp_send_material', { code, kind: kind.value, body: body.value, links: ls });
      if (error) throw error;
      toast('Материал отправлен', 'ok'); after && after();
    } }] });
}

function track(arg) {
  const code = input({ placeholder: 'Код (8 знаков) или номер, например DC-7', maxlength: 20, style: 'text-transform:uppercase' });
  const out = h('div', {});
  let saved = []; try { saved = JSON.parse(localStorage.getItem('cp-tracks') || '[]'); } catch {}
  async function check(c) {
    const v = (c || code.value).trim(); if (!v) return;
    code.value = v.toUpperCase();
    out.replaceChildren(spinner());
    const { data, error } = await sb.rpc('cp_claim_lookup', { code: v });
    if (error) return out.replaceChildren(h('p', { class: 'empty' }, errText(error)));
    if (!data) return out.replaceChildren(h('p', { class: 'empty' }, 'Иск с таким номером или кодом не найден.'));
    const link = input({ placeholder: 'https://forum…', maxlength: 500, value: data.forum_url || '' });
    out.replaceChildren(h('div', { class: 'card view' },
      h('h3', {}, `${data.no} · ${data.title}`), h('p', {}, stageTag(data.stage, data.outcome)),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Суд'), h('dd', {}, data.court),
        h('dt', {}, 'Подан'), h('dd', {}, fmtDate(data.created_at, true)),
        h('dt', {}, 'Судья'), h('dd', {}, data.judge || 'пока не назначен'),
        data.hearing ? [h('dt', {}, 'Заседание'), h('dd', {}, fmtDate(data.hearing.at, true) + (data.hearing.place ? ' · ' + data.hearing.place : ''))] : null,
        data.decided_at ? [h('dt', {}, 'Завершён'), h('dd', {}, fmtDate(data.decided_at, true))] : null,
        data.note ? [h('dt', {}, 'Сообщение суда'), h('dd', {}, data.note)] : null),
      data.own ? h('div', {}, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => sendMaterialDialog(v, () => {}) }, 'Отправить ходатайство или доказательства')),
        h('div', { class: 'row', style: 'margin-top:12px' }, h('div', { class: 'grow' }, field('Ссылка на тему на форуме', link)),
          h('button', { class: 'btn', type: 'button', onclick: async () => {
            if (link.value.trim() && !isUrl(link.value)) return toast('Нужна ссылка вида https://…', 'err');
            const { error: e2 } = await sb.rpc('cp_claim_set_link', { code: v, url: link.value.trim() }); if (e2) return toast(errText(e2), 'err'); toast('Сохранено', 'ok');
          } }, 'Сохранить'))) : h('p', { class: 'muted' }, 'Чтобы отправлять материалы, откройте страницу по коду отслеживания.')));
  }
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
  if (arg) { code.value = arg.toUpperCase(); setTimeout(() => check(arg), 0); }
  return h('div', {}, h('h1', {}, 'Статус иска'),
    h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, code), h('button', { class: 'btn primary', type: 'button', onclick: () => check() }, 'Проверить')),
    saved.length ? h('p', { class: 'muted' }, 'Ваши иски: ', saved.map((s) => h('button', { class: 'btn sm ghost', type: 'button', onclick: () => check(s.code) }, `${s.no || s.title} · ${s.code}`))) : null,
    out);
}

// ------------------------------------------------------- вход и кабинет
function authPage() {
  const mode = { v: 'in' };
  const box = h('div', { class: 'card login' });
  const draw = () => {
    const login = input({ autocomplete: 'username', placeholder: 'логин (латиница, цифры, _ . -)', maxlength: 64 });
    const pass = input({ type: 'password', autocomplete: mode.v === 'in' ? 'current-password' : 'new-password', placeholder: 'не короче 8 знаков' });
    const nick = input({ maxlength: 40, placeholder: 'как вас называть' });
    const ok = h('input', { type: 'checkbox', id: 'consent' });
    const btn = h('button', { class: 'btn primary', type: 'button' }, mode.v === 'in' ? 'Войти' : 'Зарегистрироваться');
    const go = async () => {
      if (!loginOk(login.value)) return toast('Логин: 3–32 знака, латиница, цифры и _ . -', 'err');
      if (pass.value.length < 8) return toast('Пароль не короче 8 знаков', 'err');
      if (mode.v === 'up' && !ok.checked) return toast('Нужно согласие на обработку данных', 'err');
      btn.disabled = true;
      const email = toEmail(login.value);
      const res = mode.v === 'in' ? await sb.auth.signInWithPassword({ email, password: pass.value })
        : await sb.auth.signUp({ email, password: pass.value, options: { data: { login: login.value.trim().toLowerCase(), nick: nick.value.trim(), consent: 'true', kind: 'user' } } });
      btn.disabled = false;
      if (res.error) return toast(errText(res.error), 'err');
      if (mode.v === 'up' && !res.data.session) return toast('Аккаунт создан, но Supabase требует подтверждения почты. Отключите «Confirm email» (см. README).', 'err');
      await loadMe(); render();
    };
    btn.onclick = go;
    [login, pass].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }));
    const policy = (settings.policy || '').toString();
    box.replaceChildren(h('h2', {}, mode.v === 'in' ? 'Вход' : 'Регистрация'),
      field('Логин', login), mode.v === 'up' ? field('Ник', nick) : null, field('Пароль', pass),
      mode.v === 'up' ? h('label', { class: 'check' }, ok, ' Согласен на обработку данных аккаунта', policy ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); modal({ title: 'Политика', wide: true, body: h('p', { style: 'white-space:pre-wrap' }, policy), actions: [{ label: 'Закрыть', value: true }] }); } }, ' (подробнее)') : null) : null,
      h('div', { class: 'row' }, btn, h('button', { class: 'btn ghost', type: 'button', onclick: () => { mode.v = mode.v === 'in' ? 'up' : 'in'; draw(); } }, mode.v === 'in' ? 'Создать аккаунт' : 'У меня есть аккаунт')));
  };
  draw();
  return box;
}

async function cabinet(tab = 'claims') {
  if (!me) return authPage();
  const tabs = [['claims', 'Мои иски'], ['chars', 'Персонажи'], ['acc', 'Аккаунт']];
  const body = h('div', {});
  const nav = h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('a', { href: '#/cabinet/' + k, class: k === tab ? 'on' : '' }, l)));
  body.append(spinner());
  const draw = { claims: cabClaims, chars: cabChars, acc: cabAccount }[tab] || cabClaims;
  draw().then((el) => body.replaceChildren(el)).catch((e) => body.replaceChildren(h('p', { class: 'empty' }, errText(e))));
  return h('div', {}, h('h1', {}, 'Кабинет'),
    STAFF.includes(me.profile.role) ? h('p', {}, h('a', { class: 'btn sm', href: '/panel/' }, 'Открыть панель сотрудника →')) : null, nav, body);
}

const ROLE = { author: 'Вы подали', plaintiff: 'Вы истец', defendant: 'Вы ответчик' };
async function cabClaims() {
  const { data, error } = await sb.rpc('cp_my_claims');
  if (error) throw error;
  if (!data.length) return h('div', { class: 'empty' }, h('p', {}, 'У вас пока нет исков.'), h('a', { class: 'btn primary', href: '#/claim' }, 'Подать иск'));
  const list = h('div', { class: 'stagger' });
  const reload = async () => { const el = await cabClaims(); list.parentNode.replaceWith(el); };
  data.forEach((c) => list.append(h('div', { class: 'card' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h3', {}, `${c.no} · ${c.title}`), stageTag(c.stage, c.outcome)),
    h('p', { class: 'muted' }, `${ROLE[c.role]} · ${serverName(settings, c.server)} · ${c.court} · ${fmtDate(c.created_at)}${c.judge ? ' · судья ' + c.judge : ''}`),
    c.hearing ? h('p', {}, '🗓 Заседание: ' + fmtDate(c.hearing.at, true) + (c.hearing.place ? ' · ' + c.hearing.place : '')) : null,
    c.note ? h('p', {}, h('b', {}, 'Сообщение суда: '), c.note) : null,
    (c.materials || []).length ? h('p', {}, (c.materials || []).map((m) => [h('span', { class: 'tag ' + MSTATUS[m.status][1], title: m.reason || '' }, `${MATERIAL[m.kind]}: ${MSTATUS[m.status][0]}`), ' '])) : null,
    h('div', { class: 'row' },
      c.bb ? h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(c.bb.replace(/\{\{NO\}\}/g, c.no)) }, 'Копировать BB-код') : null,
      c.track ? h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(c.track) }, 'Код ' + c.track) : null,
      h('button', { class: 'btn sm', type: 'button', onclick: () => sendMaterialDialog(c.track || c.no, reload) }, c.role === 'defendant' ? 'Отправить отзыв' : 'Отправить материал'),
      h('a', { class: 'btn sm ghost', href: '#/track/' + (c.track || c.no) }, 'Страница статуса')))));
  return h('div', {}, list);
}

async function cabChars() {
  const wrap = h('div', {});
  const draw = () => {
    const name = input({ maxlength: 60, placeholder: 'Имя Фамилия' });
    const st = input({ maxlength: 9, inputmode: 'numeric', placeholder: 'Статик (цифры)' });
    const srvSel = select(serverList(settings).map((x) => [x.code, x.name]), server);
    const countOn = (code) => me.chars.filter((c) => c.server === code).length;
    wrap.replaceChildren(
      h('p', { class: 'muted' }, 'До трёх персонажей на каждом сервере. По статику иски, где вы истец или ответчик, появляются в кабинете.'),
      h('div', { class: 'cards stagger' }, me.chars.map((c) => h('div', { class: 'card' }, h('h3', {}, c.name), h('p', { class: 'muted' }, 'Статик ' + c.static + ' · ', srvTag(c.server)),
        h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
          if (!(await confirmDlg(`Удалить персонажа ${c.name}?`, 'Удалить', true))) return;
          const { error } = await sb.from('cp_characters').delete().eq('id', c.id); if (error) return toast(errText(error), 'err');
          me.chars = me.chars.filter((x) => x.id !== c.id); draw();
        } }, 'Удалить')))),
      h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, 'Добавить персонажа'),
        h('div', { class: 'grid2' }, field('Сервер', srvSel), field('Имя', name)), field('Статик', st),
        h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          if (name.value.trim().length < 2 || !/^[0-9]{1,9}$/.test(st.value.trim())) return toast('Проверьте имя и статик (только цифры)', 'err');
          if (countOn(srvSel.value) >= 3) return toast('На этом сервере уже три персонажа', 'err');
          const { data, error } = await sb.from('cp_characters').insert({ user_id: me.id, server: srvSel.value, name: name.value.trim(), static: st.value.trim() }).select().single();
          if (error) return toast(errText(error), 'err'); me.chars.push(data); draw(); toast('Персонаж добавлен', 'ok');
        } }, 'Добавить')));
  };
  draw(); return wrap;
}

async function cabAccount() {
  const p = me.profile;
  const nick = input({ maxlength: 40, value: p.nick || '' });
  const dc = input({ maxlength: 60, value: p.discord || '', placeholder: 'ник в Discord' });
  const av = input({ maxlength: 300, value: p.avatar || '', placeholder: 'https://… (ссылка на картинку)' });
  return h('div', { class: 'card' },
    h('dl', { class: 'kv' }, h('dt', {}, 'Логин'), h('dd', {}, p.login || '—'), h('dt', {}, 'Роль'), h('dd', {}, p.role || '—')),
    field('Ник', nick), field('Discord', dc), field('Аватар', av),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        if (av.value.trim() && !isUrl(av.value)) return toast('Ссылка на аватар должна начинаться с https://', 'err');
        const patch = { nick: nick.value.trim(), discord: dc.value.trim(), avatar: av.value.trim() };
        const { error } = await sb.from('cp_profiles').update(patch).eq('id', me.id); if (error) return toast(errText(error), 'err');
        Object.assign(me.profile, patch); $('#navAcc').textContent = patch.nick || p.login; toast('Сохранено', 'ok');
      } }, 'Сохранить'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { await sb.auth.signOut(); me = null; await loadMe(); location.hash = '#/'; render(); } }, 'Выйти')));
}

// ----------------------------------------------------------------- роутер
const routes = {
  '': home, laws, decisions, hearings, guide, apply,
  claim: () => claimPage({ settings, user: me, server, serverName: serverName(settings, server), courts: courtsOf(), chars: me ? me.chars.filter((c) => c.server === server) : [] }),
  track: (a) => track(a[0]),
  cabinet: (a) => cabinet(a[0]),
};
async function render() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const name = parts[0];
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === name));
  view.replaceChildren(spinner());
  try {
    const el = await (routes[name] || home)(parts.slice(1));
    view.replaceChildren(el); view.classList.remove('view'); void view.offsetWidth; view.classList.add('view');
  } catch (e) { view.replaceChildren(h('p', { class: 'empty' }, errText(e))); }
  window.scrollTo(0, 0);
}

initTheme($('#themeBtn'));
if (!configured) view.replaceChildren(setupNotice());
else {
  await loadSettings();
  await loadMe();
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT' && me) { me = null; loadMe(); } });
  window.addEventListener('hashchange', render);
  render();
}
