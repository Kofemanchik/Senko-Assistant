// Мастер подачи иска: три шага, черновик сохраняется в браузере, на выходе BB-код для форума.
import { sb, h, errText, toast, field, input, textarea, select, copyText, isUrl, stageTag } from './common.js';
import { build, missing, FILERS } from './bbcode.js';

const DRAFT = 'cp-draft';
const blank = () => ({ court: '', filer: 'citizen', category: '', title: '', plaintiff: '', plaintiff_static: '', lawyer: '', license: '', related_no: '', contacts: '',
  defendants: [{ name: '', static: '', org: '' }], circumstances: '', requests: [''], attachments: [], fee: '' });

function loadDraft() { try { return { ...blank(), ...JSON.parse(localStorage.getItem(DRAFT) || '{}') }; } catch { return blank(); } }
const saveDraft = (st) => { try { localStorage.setItem(DRAFT, JSON.stringify(st)); } catch {} };
const clearDraft = () => { try { localStorage.removeItem(DRAFT); } catch {} };

export const FORUM_GUIDE = (forum) => h('ol', { class: 'guide' },
  h('li', {}, 'Нажмите «Скопировать BB-код» — готовый текст окажется в буфере обмена.'),
  h('li', {}, forum ? ['Откройте раздел форума для подачи исков: ', h('a', { href: forum, target: '_blank', rel: 'noopener noreferrer' }, 'перейти на форум'), '.'] : 'Откройте на форуме раздел для подачи исков вашего суда.'),
  h('li', {}, 'Нажмите «Создать тему». В заголовок впишите номер иска и его название.'),
  h('li', {}, 'В редакторе переключитесь в режим BB-кода (кнопка «BB» или «Исходный код») и вставьте скопированный текст: Ctrl+V.'),
  h('li', {}, 'Проверьте предпросмотр и опубликуйте тему.'),
  h('li', {}, 'Скопируйте адрес созданной темы и вставьте его в поле «Ссылка на тему», чтобы суд увидел иск.'));

export async function claimPage({ settings, user, chars, courts, serverName }) {
  const cats = Array.isArray(settings.claim_cats) ? settings.claim_cats : [];
  const fees = Array.isArray(settings.fees) ? settings.fees : [];
  if (!courts.length) return h('p', { class: 'empty' }, 'Для этого сервера суды ещё не настроены администратором.');
  const st = loadDraft();
  if (!courts.some((c) => c.code === st.court)) st.court = courts[0].code;
  let step = 0;
  const root = h('div', {});
  const courtName = () => (courts.find((c) => c.code === st.court) || {}).name || st.court;
  const data = () => ({ ...st, court_name: courtName() });
  const upd = () => saveDraft(st);
  const bind = (el, key) => { el.value = st[key] || ''; el.addEventListener('input', () => { st[key] = el.value; upd(); }); return el; };

  const steps = ['Кто и куда', 'Суть иска', 'Проверка'];
  const bar = () => h('ol', { class: 'steps' }, steps.map((s, i) => h('li', { class: i === step ? 'on' : i < step ? 'done' : '' }, h('b', {}, i + 1), ' ', s)));

  // ----- шаг 1
  function step1() {
    const court = bind(select(courts.map((c) => [c.code, c.name]), st.court), 'court');
    court.value = st.court;
    const filer = select(Object.entries(FILERS), st.filer);
    const lawyerBox = h('div', { class: 'grid2' });
    const showLawyer = () => { lawyerBox.hidden = st.filer !== 'lawyer'; };
    filer.addEventListener('change', () => { st.filer = filer.value; upd(); showLawyer(); });
    lawyerBox.append(field('Адвокат: имя', bind(input({ maxlength: 120 }), 'lawyer')), field('Номер лицензии', bind(input({ maxlength: 30 }), 'license')));
    showLawyer();
    const pl = bind(input({ maxlength: 120, placeholder: 'Имя Фамилия' }), 'plaintiff');
    const ps = bind(input({ maxlength: 9, inputmode: 'numeric', placeholder: 'Только цифры' }), 'plaintiff_static');
    const pick = chars.length ? field('Подставить моего персонажа', select([['', '— выбрать —'], ...chars.map((c) => [String(c.id), `${c.name} · ${c.static}`])], ''),
      'Персонажей можно завести в кабинете.') : null;
    if (pick) pick.querySelector('select').addEventListener('change', (e) => {
      const c = chars.find((x) => String(x.id) === e.target.value); if (!c) return;
      st.plaintiff = pl.value = c.name; st.plaintiff_static = ps.value = c.static; upd();
    });
    const cat = select([['', '— не выбрано —'], ...cats.map((c) => [c, c])], st.category); cat.addEventListener('change', () => { st.category = cat.value; upd(); });
    return h('div', { class: 'card' },
      h('div', { class: 'grid2' }, field('Суд', court), field('Кто подаёт', filer)),
      lawyerBox,
      h('div', { class: 'grid2' }, field('Категория', cat), field('Название иска', bind(input({ maxlength: 200, placeholder: 'Например: о возмещении ущерба' }), 'title'))),
      pick,
      h('div', { class: 'grid2' }, field('Истец', pl), field('Статик истца', ps)),
      h('div', { class: 'grid2' }, field('Контакты для связи', bind(input({ maxlength: 120, placeholder: 'Discord или ник в игре' }), 'contacts')), field('Связанное дело (если есть)', bind(input({ maxlength: 30, placeholder: 'DC-12' }), 'related_no'))),
      null);
  }

  // ----- шаг 2
  function listEditor(arr, mk, render, addLabel, max, min = 1) {
    const box = h('div', {});
    const draw = () => {
      box.replaceChildren(...arr.map((it, i) => h('div', { class: 'li-row' }, render(it, i), arr.length > min ? h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': 'Убрать', onclick: () => { arr.splice(i, 1); upd(); draw(); } }, '✕') : null)),
        arr.length < max ? h('button', { class: 'btn sm', type: 'button', onclick: () => { arr.push(mk()); upd(); draw(); } }, addLabel) : null);
    };
    draw(); return box;
  }
  function step2() {
    const defs = listEditor(st.defendants, () => ({ name: '', static: '', org: '' }), (d) => h('div', { class: 'grid3' },
      field('Ответчик', input({ maxlength: 120, placeholder: 'Имя Фамилия', value: d.name })),
      field('Статик', input({ maxlength: 9, inputmode: 'numeric', value: d.static })),
      field('Организация (если есть)', input({ maxlength: 120, value: d.org }))), '+ Ещё ответчик', 10);
    // привязка полей ответчиков по делегированию, чтобы не терять фокус при перерисовке
    defs.addEventListener('input', (e) => {
      const rows = [...defs.querySelectorAll('.li-row')]; const i = rows.findIndex((r) => r.contains(e.target)); if (i < 0) return;
      const ins = [...rows[i].querySelectorAll('input')]; st.defendants[i] = { name: ins[0].value, static: ins[1].value, org: ins[2].value }; upd();
    });
    const reqs = listEditor(st.requests, () => '', (r) => input({ maxlength: 1000, value: r, placeholder: 'Что вы просите у суда' }), '+ Ещё требование', 15);
    reqs.addEventListener('input', (e) => {
      const rows = [...reqs.querySelectorAll('.li-row')]; const i = rows.findIndex((r) => r.contains(e.target)); if (i < 0) return;
      st.requests[i] = e.target.value; upd();
    });
    const atts = listEditor(st.attachments, () => ({ name: '', url: '' }), (a) => h('div', { class: 'grid2' },
      input({ maxlength: 120, value: a.name, placeholder: 'Название (скриншот, видео…)' }), input({ maxlength: 500, value: a.url, placeholder: 'https://…' })), '+ Добавить ссылку на доказательство', 20, 0);
    atts.addEventListener('input', (e) => {
      const rows = [...atts.querySelectorAll('.li-row')]; const i = rows.findIndex((r) => r.contains(e.target)); if (i < 0) return;
      const ins = rows[i].querySelectorAll('input'); st.attachments[i] = { name: ins[0].value, url: ins[1].value }; upd();
    });
    const circ = bind(textarea({ rows: 8, maxlength: 8000, placeholder: 'Опишите, что произошло: когда, где, кто участвовал, какой ущерб.' }), 'circumstances');
    return h('div', { class: 'card' },
      h('h3', {}, 'Ответчики'), defs,
      field('Обстоятельства дела', circ, 'От 30 знаков. Пишите по фактам и по порядку.'),
      h('h3', {}, 'Требования'), reqs,
      h('h3', { style: 'margin-top:14px' }, 'Приложения'), h('p', { class: 'muted' }, 'Ссылки на файлы, видео и скриншоты. Откройте доступ по ссылке заранее.'), atts,
      field('Госпошлина', fees.length ? bind(select([['', '— не выбрано —'], ...fees.map((f) => [String(f), String(f)])], st.fee), 'fee') : bind(input({ maxlength: 120 }), 'fee')));
  }

  // ----- шаг 3
  function step3() {
    const d = data(); const miss = missing(d);
    const badUrl = st.attachments.filter((a) => (a.url || '').trim() && !isUrl(a.url));
    const { bb } = build(d);
    const out = h('pre', { class: 'doc' }, bb);
    const btn = h('button', { class: 'btn primary', type: 'button' }, 'Зарегистрировать иск');
    btn.onclick = async () => {
      if (miss.length || badUrl.length) return toast('Сначала заполните недостающее', 'err');
      btn.disabled = true;
      const { text, bb: bb2 } = build(d);
      const { data: r, error } = await sb.rpc('cp_file_claim', { p: { ...d, defendants: d.defendants, requests: d.requests, attachments: d.attachments.filter((a) => (a.url || '').trim()), text, bb: bb2 } });
      btn.disabled = false;
      if (error) return toast(errText(error), 'err');
      clearDraft();
      try { const arr = JSON.parse(localStorage.getItem('cp-tracks') || '[]'); arr.unshift({ code: r.track, no: r.no, title: st.title, at: Date.now() }); localStorage.setItem('cp-tracks', JSON.stringify(arr.slice(0, 20))); } catch {}
      done(r, bb2.replace(/\{\{NO\}\}/g, r.no));
    };
    return h('div', {},
      miss.length || badUrl.length ? h('div', { class: 'card warn' }, h('h3', {}, 'Осталось заполнить'),
        h('ul', {}, miss.map((m) => h('li', {}, m)), badUrl.map((a) => h('li', {}, `ссылка «${a.name || a.url}» должна начинаться с http:// или https://`)))) : h('div', { class: 'card' }, h('p', {}, '✅ Всё заполнено. Проверьте текст и зарегистрируйте иск.')),
      h('h3', {}, 'Так выглядит BB-код'), out,
      h('p', { class: 'muted' }, 'Номер иска подставится после регистрации.'), btn);
  }

  function done(r, bb) {
    const link = input({ placeholder: 'https://forum…/threads/…', maxlength: 500 });
    root.replaceChildren(h('div', { class: 'card ok-card' },
      h('h1', {}, 'Иск зарегистрирован'),
      h('p', {}, 'Номер иска: ', h('b', {}, r.no)),
      h('p', {}, 'Код отслеживания: ', h('b', { class: 'code' }, r.track), ' — сохраните его, по нему виден статус.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => copyText(bb) }, 'Скопировать BB-код'),
        h('button', { class: 'btn', type: 'button', onclick: () => copyText(r.track) }, 'Скопировать код'),
        h('a', { class: 'btn ghost', href: '#/track/' + r.track }, 'Открыть статус'))),
      h('div', { class: 'card' }, h('h3', {}, 'Как опубликовать на форуме'), FORUM_GUIDE((courts.find((c) => c.code === st.court) || {}).forum),
        field('Ссылка на тему', link),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          if (!isUrl(link.value)) return toast('Нужна ссылка вида https://…', 'err');
          const { error } = await sb.rpc('cp_claim_set_link', { code: r.track, url: link.value.trim() });
          if (error) return toast(errText(error), 'err'); toast('Ссылка сохранена', 'ok');
        } }, 'Сохранить ссылку')));
    window.scrollTo(0, 0);
  }

  function draw() {
    const body = [step1, step2, step3][step]();
    const prev = h('button', { class: 'btn', type: 'button', disabled: step === 0, onclick: () => { step--; draw(); } }, '← Назад');
    const next = step < 2 ? h('button', { class: 'btn primary', type: 'button', onclick: () => { step++; draw(); window.scrollTo(0, 0); } }, 'Далее →') : null;
    const reset = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { Object.assign(st, blank(), { court: st.court }); clearDraft(); step = 0; draw(); toast('Черновик очищен'); } }, 'Очистить черновик');
    root.replaceChildren(h('h1', {}, 'Подача иска'), h('p', { class: 'muted' }, 'Сервер: ', h('b', {}, serverName), '. Сайт соберёт готовый BB-код. Опубликуйте его на форуме по инструкции. Черновик хранится в вашем браузере.'),
      bar(), body, h('div', { class: 'row', style: 'justify-content:space-between;margin-top:12px' }, prev, h('span', { class: 'row' }, reset, next)));
  }
  draw();
  return root;
}
