// Сборка текста иска и его BB-кода для форума. {{NO}} заменяется номером иска на сервере.
const clean = (s) => String(s ?? '').replace(/\[(\/?)(b|i|u|center|size|color|list|url|img|quote|\*)/gi, '［$1$2').trim();
const line = (s) => clean(s).replace(/\s*\n\s*/g, ' ');

export const FILERS = { citizen: 'Гражданин (лично)', lawyer: 'Адвокат (по доверенности)' };

// d: {court_name, filer, title, plaintiff, plaintiff_static, lawyer, license, defendants[], related_no,
//     circumstances, requests[], attachments[], fee, contacts}
export function missing(d) {
  const m = [];
  if (!d.court) m.push('суд');
  if (clean(d.title).length < 3) m.push('название иска');
  if (clean(d.plaintiff).length < 2) m.push('имя истца');
  if (!/^[0-9]{1,9}$/.test(String(d.plaintiff_static || '').trim())) m.push('статик истца (цифры)');
  if (d.filer === 'lawyer' && (clean(d.lawyer).length < 2 || !clean(d.license))) m.push('данные адвоката');
  if (!(d.defendants || []).some((x) => clean(x.name).length >= 2)) m.push('ответчик');
  if (clean(d.circumstances).length < 30) m.push('обстоятельства (от 30 знаков)');
  if (!(d.requests || []).some((x) => clean(x))) m.push('требования');
  if (clean(d.contacts).length < 2) m.push('контакты');
  return m;
}

export function build(d) {
  const defs = (d.defendants || []).filter((x) => clean(x.name));
  const reqs = (d.requests || []).map(clean).filter(Boolean);
  const atts = (d.attachments || []).filter((a) => clean(a.url));
  const who = d.filer === 'lawyer'
    ? `Адвокат ${line(d.lawyer)} (лицензия № ${line(d.license)}), представитель истца ${line(d.plaintiff)} (статик ${line(d.plaintiff_static)})`
    : `${line(d.plaintiff)} (статик ${line(d.plaintiff_static)})`;
  const defLine = (x) => `${line(x.name)}${x.static ? ' (статик ' + line(x.static) + ')' : ''}${x.org ? ', ' + line(x.org) : ''}`;

  const t = [];
  t.push(`ИСКОВОЕ ЗАЯВЛЕНИЕ № {{NO}}`, `${line(d.court_name || d.court)}`, '', line(d.title), '');
  t.push(`Истец: ${who}`);
  t.push(`Ответчик${defs.length > 1 ? 'и' : ''}: ${defs.map(defLine).join('; ')}`);
  if (clean(d.related_no)) t.push(`Связанное дело: ${line(d.related_no)}`);
  if (clean(d.fee)) t.push(`Госпошлина: ${line(d.fee)}`);
  t.push('', 'ОБСТОЯТЕЛЬСТВА', clean(d.circumstances), '', 'ИСКОВЫЕ ТРЕБОВАНИЯ');
  reqs.forEach((r, i) => t.push(`${i + 1}. ${r}`));
  if (atts.length) { t.push('', 'ПРИЛОЖЕНИЯ'); atts.forEach((a, i) => t.push(`${i + 1}. ${line(a.name) || 'Материал'} — ${a.url.trim()}`)); }
  t.push('', `Контакты: ${line(d.contacts)}`);

  const b = [];
  b.push(`[center][b][size=5]ИСКОВОЕ ЗАЯВЛЕНИЕ № {{NO}}[/size][/b]`, `${line(d.court_name || d.court)}`, '', `[b]${line(d.title)}[/b][/center]`, '');
  b.push(`[b]Истец:[/b] ${who}`);
  b.push(`[b]Ответчик${defs.length > 1 ? 'и' : ''}:[/b] ${defs.map(defLine).join('; ')}`);
  if (clean(d.related_no)) b.push(`[b]Связанное дело:[/b] ${line(d.related_no)}`);
  if (clean(d.fee)) b.push(`[b]Госпошлина:[/b] ${line(d.fee)}`);
  b.push('', '[b]ОБСТОЯТЕЛЬСТВА[/b]', clean(d.circumstances), '', '[b]ИСКОВЫЕ ТРЕБОВАНИЯ[/b]', '[list=1]');
  reqs.forEach((r) => b.push(`[*]${r}`));
  b.push('[/list]');
  if (atts.length) {
    b.push('', '[b]ПРИЛОЖЕНИЯ[/b]', '[list=1]');
    atts.forEach((a) => b.push(`[*][url=${a.url.trim()}]${line(a.name) || 'Материал'}[/url]`));
    b.push('[/list]');
  }
  b.push('', `[b]Контакты:[/b] ${line(d.contacts)}`);
  return { text: t.join('\n'), bb: b.join('\n') };
}
