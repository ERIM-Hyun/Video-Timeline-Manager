/* 테마(라이트/다크 + 색 톤) — 화면이 그려지기 전에 적용해 깜빡임을 막기 위해 <head>에서 불러옵니다.
   설정은 이 브라우저의 localStorage('tlm-theme')에 저장됩니다. */
(function () {
  const KEY = 'tlm-theme';
  const DEF = { mode: 'light', hue: 221, sat: 84, tint: 14 };     // mode: light | dark | system
  const PRESETS = [
    { name: '파랑 (기본)', hue: 221, sat: 84, tint: 14 },
    { name: '하늘', hue: 199, sat: 85, tint: 16 },
    { name: '청록', hue: 174, sat: 70, tint: 14 },
    { name: '초록', hue: 142, sat: 55, tint: 12 },
    { name: '노랑·주황', hue: 32, sat: 90, tint: 16 },
    { name: '분홍', hue: 336, sat: 75, tint: 14 },
    { name: '보라', hue: 266, sat: 68, tint: 14 },
    { name: '회색', hue: 220, sat: 6, tint: 6 },
  ];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);

  function load() {
    let o = {};
    try { o = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* 저장소를 쓸 수 없으면 기본값 */ }
    return {
      mode: ['light', 'dark', 'system'].includes(o.mode) ? o.mode : DEF.mode,
      hue: clamp(num(o.hue, DEF.hue), 0, 360), sat: clamp(num(o.sat, DEF.sat), 0, 100), tint: clamp(num(o.tint, DEF.tint), 0, 40),
    };
  }
  function save(t) { try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* 무시 */ } }
  const isDark = t => t.mode === 'dark' || (t.mode === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);

  function hslToRgb(h, s, l) {
    s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
  }
  function onColor(h, s, l) {                      // 강조색 위에 올릴 글자색(흰색/어두운색) 자동 선택
    const [r, g, b] = hslToRgb(h, s, l).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return L > 0.4 ? '#14181f' : '#ffffff';
  }

  function palette(t) {
    const dark = isDark(t), H = t.hue, S = t.sat, N = t.tint;
    const c = (l, s = N) => `hsl(${H} ${Math.round(s)}% ${l}%)`;
    if (!dark) {
      const acc = [H, S, 56];
      return {
        '--bg': c(96), '--panel': '#ffffff', '--panel2': c(98.5), '--hover': c(95), '--line': c(89, N + 1), '--line2': c(95),
        '--chipbg': c(92), '--barbg': c(93), '--inbd': c(78, N + 10), '--text': c(13, N + 4), '--sub': c(45), '--sub2': c(63), '--ink2': c(27),
        '--ntext': '#1c2128', '--nsub': '#69727e', '--nsub2': '#9aa3af', '--nink2': '#39414c',   // 즐겨찾기 창용: 테마 색이 섞이지 않는 글자색
        '--kwbg': c(96, Math.min(60, S * 0.6)), '--kwbd': c(84, S * 0.35), '--codebg': c(95), '--codefg': c(32, S * 0.3),
        '--accent': `hsl(${acc[0]} ${acc[1]}% ${acc[2]}%)`, '--accent-soft': `hsl(${H} ${Math.min(95, S + 8)}% 95%)`, '--accent-strong': `hsl(${H} ${S}% 46%)`,
        '--on-accent': onColor(...acc), '--sel': `hsl(${H} ${Math.min(100, S + 16)}% 90%)`, '--flash': '#ffd54f',
        '--seg-a': `hsl(${H} ${S * 0.5}% 83%)`, '--seg-b': `hsl(${H} ${S * 0.55}% 73%)`, '--segline': '#ffffff',
        '--hit': '#f08a00', '--hit-soft': '#fff1d6', '--warn': '#c0392b', '--on-warn': '#ffffff', '--warnbg': '#fdecea', '--yelbg': '#fff9e6',
        '--stalebg': '#fff3cd', '--stalebd': '#f0d98a', '--stalefg': '#7a5200', '--stalever': '#b42318',
        '--gryb': '#6b7686', '--gryt': '#ffffff', '--gryh': '#566070', '--shadow': 'rgba(0,0,0,.25)',
      };
    }
    const acc = [H, S, 60];
    return {
      '--bg': c(10), '--panel': c(13), '--panel2': c(15.5), '--hover': c(19), '--line': c(25), '--line2': c(20),
      '--chipbg': c(21), '--barbg': c(18), '--inbd': c(36), '--text': c(90, N * 0.6), '--sub': c(66, N * 0.6), '--sub2': c(50, N * 0.6), '--ink2': c(78, N * 0.6),
      '--ntext': '#e6e9ef', '--nsub': '#a3acba', '--nsub2': '#7d8696', '--nink2': '#c9d0da',
      '--kwbg': c(22, S * 0.35), '--kwbd': c(34, S * 0.3), '--codebg': c(21), '--codefg': c(80, S * 0.6),
      '--accent': `hsl(${acc[0]} ${acc[1]}% ${acc[2]}%)`, '--accent-soft': `hsl(${H} ${S * 0.55}% 24%)`, '--accent-strong': `hsl(${H} ${S}% 70%)`,
      '--on-accent': onColor(...acc), '--sel': `hsl(${H} ${S * 0.6}% 30%)`, '--flash': '#8a6a00',
      '--seg-a': `hsl(${H} ${S * 0.35}% 32%)`, '--seg-b': `hsl(${H} ${S * 0.4}% 42%)`, '--segline': c(13),
      '--hit': '#f59f1b', '--hit-soft': 'hsl(35 55% 24%)', '--warn': '#ff7b6b', '--on-warn': '#2a0d0a', '--warnbg': 'hsl(5 40% 22%)', '--yelbg': 'hsl(45 40% 18%)',
      '--stalebg': 'hsl(45 40% 20%)', '--stalebd': 'hsl(45 35% 32%)', '--stalefg': '#f3d98b', '--stalever': '#ff8a7a',
      '--gryb': '#4a5260', '--gryt': '#e6e9ee', '--gryh': '#5a6373', '--shadow': 'rgba(0,0,0,.6)',
    };
  }

  function apply(t) {
    t = t || load();
    const root = document.documentElement, p = palette(t);
    for (const [k, v] of Object.entries(p)) root.style.setProperty(k, v);
    root.style.colorScheme = isDark(t) ? 'dark' : 'light';
    root.dataset.theme = isDark(t) ? 'dark' : 'light';
    return t;
  }
  function set(patch) { const t = Object.assign(load(), patch); save(t); return apply(t); }
  function reset() { try { localStorage.removeItem(KEY); } catch { /* 무시 */ } return apply(load()); }

  window.TLMTheme = { DEF, PRESETS, load, apply, set, reset, isDark };
  apply();
  if (window.matchMedia) {                                   // '시스템' 모드: OS 설정이 바뀌면 따라감
    const mq = matchMedia('(prefers-color-scheme: dark)'), fn = () => { if (load().mode === 'system') apply(); };
    mq.addEventListener ? mq.addEventListener('change', fn) : mq.addListener && mq.addListener(fn);
  }
})();
