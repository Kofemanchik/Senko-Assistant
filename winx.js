// Режимы окна 2.2: призрачный режим по уходу курсора, сворачивание в полоску при бездействии,
// прилипание к краю экрана, профили окна «в игре» и «за столом», реакция на выбранную программу
// и поиск программ для записи экрана (режим «Стрим»).
const { screen } = require("electron");
const { execFile, spawn } = require("child_process");

const STRIP_H = 36;      // высота полоски = высота строки заголовка
const SNAP_PX = 18;      // на каком расстоянии от края окно прилипает
const STREAM_APPS = ["obs64", "obs32", "obs", "streamlabs obs", "streamlabs desktop", "bdcam", "bandicam", "xsplit.core", "xsplit.broadcaster",
  "action_x64", "mirillis action!", "camtasia", "camrecorder", "fraps", "dxtory", "twitch studio", "medal"];
const NAME_RE = /^[a-z0-9 ._!+()-]{2,40}$/i;
// одна PowerShell на всё время работы: раз в 0,7 с пишет имя процесса активного окна, когда оно меняется
const FG_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "Add-Type -Namespace SA -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p);'",
  "$last=''",
  "while($true){ $p=0; [void][SA.W]::GetWindowThreadProcessId([SA.W]::GetForegroundWindow(), [ref]$p); $n=''; if($p){ $n=(Get-Process -Id $p).ProcessName }; if($n -ne $last){ $last=$n; [Console]::Out.WriteLine('fg:'+$n); [Console]::Out.Flush() }; Start-Sleep -Milliseconds 700 }"
].join("; ");

module.exports = function (ctx) {
  // ctx: win(), cfg(), save(), apply() (прозрачность и «поверх окон»), push() (состояние в окно), setCompact(on), unmax()
  let cursorIn = true, outSince = Date.now(), strip = null, pollT = null, streamT = null, fg = "", fgProc = null, stream = [], hidden = false, snapping = false;
  const W = () => { const w = ctx.win(); return w && !w.isDestroyed() ? w : null; };
  const C = () => ctx.cfg();

  function norm(n) { return String(n || "").toLowerCase().replace(/\.exe$/i, "").trim(); }
  function inside(b, p) { return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height; }

  // ── курсор: призрачный режим по уходу курсора и полоска ──
  function needPoll() { const c = C(); return (c.ghost && c.ghostBy === "cursor") || c.strip > 0; }
  function poll() {
    const w = W();
    if (!w || !w.isVisible() || w.isMinimized()) return;
    const now = inside(w.getBounds(), screen.getCursorScreenPoint());
    if (now !== cursorIn) {
      cursorIn = now;
      if (!now) outSince = Date.now();
      if (C().ghost && C().ghostBy === "cursor") ctx.apply();
    }
    if (strip && cursorIn) unstrip();
    else if (!strip && C().strip > 0 && !cursorIn && !w.isFocused() && Date.now() - outSince > C().strip * 60e3) toStrip();
  }
  function restartPoll() {
    clearInterval(pollT); pollT = null;
    if (needPoll()) pollT = setInterval(poll, 250);
    else if (strip) unstrip();
    cursorIn = true; ctx.apply();
  }
  function toStrip() {
    const w = W();
    if (!w || w.isMaximized() || w.isFullScreen()) return;
    const b = w.getBounds();
    strip = { b, min: w.getMinimumSize() };
    w.setMinimumSize(200, STRIP_H);
    w.setBounds({ x: b.x, y: b.y, width: b.width, height: STRIP_H });
    ctx.push();
  }
  function unstrip() {
    const w = W(), s = strip;
    strip = null;
    if (!w || !s) return;
    w.setMinimumSize(s.min[0], s.min[1]);
    const cur = w.getBounds(); // полоску могли передвинуть: разворачиваем на новом месте
    w.setBounds({ x: cur.x, y: cur.y, width: s.b.width, height: s.b.height });
    outSince = Date.now();
    ctx.push();
  }

  // ── прилипание к краям экрана ──
  function onMoved() {
    const w = W();
    if (!w || !C().snap || snapping || strip || w.isMaximized()) return;
    const b = w.getBounds(), a = screen.getDisplayMatching(b).workArea;
    let x = b.x, y = b.y;
    if (Math.abs(b.x - a.x) <= SNAP_PX) x = a.x;
    else if (Math.abs(a.x + a.width - (b.x + b.width)) <= SNAP_PX) x = a.x + a.width - b.width;
    if (Math.abs(b.y - a.y) <= SNAP_PX) y = a.y;
    else if (Math.abs(a.y + a.height - (b.y + b.height)) <= SNAP_PX) y = a.y + a.height - b.height;
    if (x === b.x && y === b.y) return;
    snapping = true;
    w.setBounds({ x, y, width: b.width, height: b.height });
    setTimeout(() => { snapping = false; }, 50);
  }

  // ── программа, при которой окно прячется или становится прозрачным ──
  function watchOn() { return process.platform === "win32" && (C().watchApps || []).length > 0; }
  function fgMatch() { return !!fg && (C().watchApps || []).includes(fg); }
  function startFg() {
    if (fgProc || !watchOn()) return;
    try {
      // скрипт передаётся в base64 (-EncodedCommand), чтобы кавычки не ломались при разборе командной строки
      fgProc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(FG_PS, "utf16le").toString("base64")], { windowsHide: true });
      let buf = "";
      fgProc.stdout.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (line.indexOf("fg:") === 0) onFg(norm(line.slice(3)));
        }
      });
      fgProc.on("exit", () => { fgProc = null; });
      fgProc.on("error", () => { fgProc = null; });
    } catch (e) { fgProc = null; }
  }
  function stopFg() { if (fgProc) { try { fgProc.kill(); } catch (e) {} fgProc = null; } fg = ""; onFg(""); }
  function onFg(name) {
    const self = norm(process.execPath.split(/[\\/]/).pop());
    if (name === self) return; // своё окно: состояние не меняем
    fg = name;
    const w = W(), m = fgMatch();
    if (!w) return;
    if (C().watchMode === "hide") {
      if (m && w.isVisible() && !hidden) { hidden = true; w.hide(); }
      else if (!m && hidden) { hidden = false; w.showInactive(); }
    } else {
      if (hidden) { hidden = false; w.showInactive(); }
      ctx.apply();
    }
  }

  // ── программы для записи и трансляций ──
  function scanStream() {
    if (process.platform !== "win32" || !C().streamAuto) { if (stream.length) { stream = []; ctx.push(); } return; }
    execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, timeout: 8000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return;
      const names = new Set(String(out).split(/\r?\n/).map((l) => norm((/^"([^"]+)"/.exec(l) || [])[1])).filter(Boolean));
      const found = STREAM_APPS.filter((n) => names.has(n));
      if (found.join() !== stream.join()) { stream = found; ctx.push(); }
    });
  }
  function restartStream() {
    clearInterval(streamT); streamT = null;
    if (process.platform === "win32" && C().streamAuto) { scanStream(); streamT = setInterval(scanStream, 20000); }
    else if (stream.length) { stream = []; ctx.push(); }
  }

  // ── профили окна ──
  const PROF = ["game", "desk"];
  function profSave(name) {
    const w = W(), c = C();
    if (!w || !PROF.includes(name)) return { ok: false, error: "Неизвестный профиль." };
    if (strip) unstrip();
    c.winProfiles = c.winProfiles && typeof c.winProfiles === "object" ? c.winProfiles : {};
    c.winProfiles[name] = { bounds: w.isMaximized() ? null : w.getBounds(), max: w.isMaximized(), alwaysOnTop: !!c.alwaysOnTop, opacity: c.opacity, ghost: !!c.ghost, ghostOpacity: c.ghostOpacity, compact: !!c.compact, at: Date.now() };
    c.winProfile = name;
    ctx.save(); ctx.push();
    return { ok: true };
  }
  function profUse(name) {
    const w = W(), c = C(), p = c.winProfiles && c.winProfiles[name];
    if (!w || !p) return { ok: false, error: "Этот профиль ещё не сохранён." };
    if (strip) unstrip();
    if (!!p.compact !== !!c.compact) ctx.setCompact(!!p.compact);
    c.alwaysOnTop = !!p.alwaysOnTop; c.ghost = !!p.ghost;
    c.opacity = Math.min(100, Math.max(30, +p.opacity || 100));
    c.ghostOpacity = Math.min(90, Math.max(20, +p.ghostOpacity || 55));
    if (p.max) w.maximize();
    else if (p.bounds) { if (w.isMaximized()) w.unmaximize(); const v = ctx.visible(p.bounds); if (v) w.setBounds(v); }
    c.winProfile = name;
    ctx.apply(); restartPoll(); ctx.save(); ctx.push();
    return { ok: true };
  }

  return {
    keys: ["ghostBy", "strip", "snap", "watchApps", "watchMode", "watchOpacity", "streamAuto"],
    defaults: { ghostBy: "blur", strip: 0, snap: false, watchApps: [], watchMode: "fade", watchOpacity: 25, streamAuto: true, winProfiles: {}, winProfile: "" },
    fix(c) {
      c.ghostBy = c.ghostBy === "cursor" ? "cursor" : "blur";
      c.strip = [0, 1, 2, 5, 10, 15].includes(+c.strip) ? +c.strip : 0;
      c.snap = !!c.snap; c.streamAuto = c.streamAuto !== false;
      c.watchApps = Array.isArray(c.watchApps) ? [...new Set(c.watchApps.map(norm).filter((n) => NAME_RE.test(n)))].slice(0, 10) : [];
      c.watchMode = c.watchMode === "hide" ? "hide" : "fade";
      c.watchOpacity = Math.min(90, Math.max(10, Math.round(+c.watchOpacity || 25)));
      if (!c.winProfiles || typeof c.winProfiles !== "object") c.winProfiles = {};
      if (!PROF.includes(c.winProfile)) c.winProfile = "";
    },
    set(key, val) {
      const c = C();
      if (key === "ghostBy") c.ghostBy = val === "cursor" ? "cursor" : "blur";
      else if (key === "strip") c.strip = [0, 1, 2, 5, 10, 15].includes(+val) ? +val : 0;
      else if (key === "snap") c.snap = !!val;
      else if (key === "streamAuto") c.streamAuto = !!val;
      else if (key === "watchMode") c.watchMode = val === "hide" ? "hide" : "fade";
      else if (key === "watchOpacity") c.watchOpacity = Math.min(90, Math.max(10, Math.round(+val || 25)));
      else if (key === "watchApps") {
        const L = (Array.isArray(val) ? val : String(val || "").split(/[,;\n]+/)).map(norm).filter(Boolean);
        const bad = L.find((n) => !NAME_RE.test(n));
        if (bad) return { ok: false, error: "Непонятное имя программы: " + bad };
        c.watchApps = [...new Set(L)].slice(0, 10);
      }
      if (key === "watchApps" || key === "watchMode") { stopFg(); startFg(); }
      if (key === "streamAuto") restartStream();
      restartPoll();
      return { ok: true };
    },
    start() {
      restartPoll(); restartStream(); startFg();
      const w = W();
      if (w) { w.on("moved", onMoved); w.on("focus", () => { if (strip) unstrip(); }); }
    },
    stop() { clearInterval(pollT); clearInterval(streamT); stopFg(); },
    // для прозрачности окна: призрачный режим и «прозрачность при программе»
    ghostNow() {
      const w = W(), c = C();
      if (!w || !w.isVisible()) return false;
      return c.ghostBy === "cursor" ? !cursorIn : !w.isFocused();
    },
    fadeNow() { return C().watchMode !== "hide" && fgMatch(); },
    stripped: () => !!strip,
    unstrip,
    stream: () => stream.slice(),
    fg: () => fg,
    profSave, profUse,
    state() { const c = C(); return { strip: !!strip, stream: stream.slice(), profiles: PROF.filter((n) => c.winProfiles && c.winProfiles[n]), profile: c.winProfile }; }
  };
};
