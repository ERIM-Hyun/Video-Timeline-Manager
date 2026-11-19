'use strict';
/* 영상 타임라인 매니저 - 화면 로직 (서버 app.py 의 /api/* 와 통신) */

const WEB_VERSION = '1.1.0 (2026-11-20)';   // 화면(웹 파일) 버전 — app.py의 APP_VERSION과 같아야 합니다
const S = {
  lib: null, videos: [], errors: [], refs: { version: 1, videos: {} },
  selKey: null, selEntry: null, query: '', vq: '', zoom: null, only: false, onlyHit: true, scope: { text: true, kw: true, ref: true },
  sortDesc: true, mode: 'tree', stamp: null,
  hits: {},            // 영상키 -> {n: 일치한 타임스탬프 수, occ: 단어 일치 횟수}
  kwIndex: new Map(),  // 키워드(소문자) -> [{v, e}]
  toggle: new Map(),   // 'videoKey|entryKey' -> 펼침 여부(사용자가 직접 바꾼 것)
  editing: false,
};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cmp = (a, b) => a.localeCompare(b, 'ko');
const normKw = k => String(k).normalize('NFC').trim().toLowerCase();

/* ---------- 공통 도구 ---------- */
async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TLM': '1' }, body: JSON.stringify(body),
  };
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('오류 ' + r.status));
  return j;
}
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}
function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function parseTime(v) {
  const s = String(v).trim().replace(/[;；:：]/g, ':');
  let m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  m = s.match(/^(?:(\d+)\s*시간?)?\s*(?:(\d+)\s*분)?\s*(?:(\d+)\s*초)?$/);
  if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  if (/^\d+$/.test(s)) return +s;
  return null;
}
function normUrl(url) { return /^https?:/i.test(url) ? url : 'https://' + url; }
function jumpUrl(url, sec) {
  if (!url) return '';
  try { const u = new URL(normUrl(url)); u.searchParams.set('t', Math.floor(sec) + 's'); return u.toString(); }
  catch { return url; }
}
// 유튜브 링크(…?t=3723, &t=1h2m3s, #t=90, &start=90)에서 시작 시간(초)과 영상 ID를 꺼냅니다. 링크가 아니면 null.
function linkTime(text) {
  const m = String(text).trim().match(/https?:\/\/[^\s]+/i); if (!m) return null;
  let u; try { u = new URL(m[0]); } catch { return null; }
  const h = u.hostname.replace(/^www\.|^m\./, '');
  if (h !== 'youtu.be' && !h.endsWith('youtube.com')) return null;
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  const raw = u.searchParams.get('t') ?? u.searchParams.get('start') ?? hash.get('t');
  let sec = 0;
  if (raw) {
    const r = String(raw).trim();
    const p = r.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
    if (/^\d+$/.test(r)) sec = +r;
    else if (p && (p[1] || p[2] || p[3])) sec = (+p[1] || 0) * 3600 + (+p[2] || 0) * 60 + (+p[3] || 0);
    else if (parseTime(r) != null) sec = parseTime(r);
    else return { sec: null, id: ytId(m[0]) };
  }
  return { sec, id: ytId(m[0]), hasT: !!raw };
}
function ytId(url) {
  if (!url) return null;
  try {
    const u = new URL(normUrl(url));
    const h = u.hostname.replace(/^www\.|^m\./, '');
    if (h === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (h.endsWith('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{6,})/);
      if (m) return m[1];
    }
  } catch { /* 무시 */ }
  return null;
}
// 유튜브 공식 임베드 플레이어 주소 (영상 이미지를 따로 불러오거나 저장하지 않습니다)
const embedUrl = (id, sec, auto) => `https://www.youtube.com/embed/${encodeURIComponent(id)}?rel=0&playsinline=1&enablejsapi=1${/^https?:/.test(location.protocol) ? '&origin=' + encodeURIComponent(location.origin) : ''}${sec > 0 ? '&start=' + Math.floor(sec) : ''}${auto ? '&autoplay=1' : ''}`;
const PLACE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>';

/* 간단한 대화상자: input 이 있으면 문자열(취소 시 null), 없으면 true/false */
function ask({ title, msg = '', value = null, ok = '확인', danger = false }) {
  return new Promise(res => {
    const d = $('#dlg'), inp = $('#dlgI');
    $('#dlgT').textContent = title; $('#dlgM').textContent = msg;
    inp.style.display = value === null ? 'none' : ''; inp.value = value ?? '';
    $('#dlgOk').textContent = ok; $('#dlgOk').classList.toggle('danger', !!danger);
    const cancelVal = value === null ? false : null;
    const done = v => { d.close(); res(v); };
    $('#dlgOk').onclick = () => done(value === null ? true : (inp.value.trim() || value));
    $('#dlgNo').onclick = () => done(cancelVal);
    d.oncancel = e => { e.preventDefault(); done(cancelVal); };
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#dlgOk').click(); } };
    d.showModal();
    if (value !== null) { inp.focus(); inp.select(); }
  });
}

/* ---------- 데이터 ---------- */
const curVideo = () => S.videos.find(v => v.key === S.selKey) || null;
const validEntries = v => v.entries.filter(e => !e.bad);
const curEntry = () => { const v = curVideo(); return v ? v.entries.find(e => e.key === S.selEntry) || null : null; };
const entryRefs = (v, e) => S.refs.videos[v.key]?.refs?.[e.key] || [];
const lastSec = v => validEntries(v).at(-1)?.sec ?? 0;
/* 엑셀의 '재생 시간' 칸 값 (마지막 타임스탬프보다 짧으면 무시) */
const excelDur = v => (v.duration && v.duration >= lastSec(v)) ? v.duration : 0;
function duration(v) {
  if (excelDur(v)) return excelDur(v);
  const o = S.refs.videos[v.key]?.duration;
  const last = lastSec(v);
  if (o && o >= last) return o;
  return last + Math.max(30, Math.round(last * 0.08));
}
const hasCustomDuration = v => { const o = S.refs.videos[v.key]?.duration; return !!o && o >= lastSec(v); };

async function persist() {
  try { S.refs = await api('/api/refs', S.refs); }
  catch (err) { toast('저장 실패: ' + err.message); }
}

/* 키워드 색상 */
const kwColor = k => S.refs.keywordColors?.[normKw(k)] || '';
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1c2128' : '#ffffff';
}
const kwStyle = k => { const c = kwColor(k); return c ? ` style="background:${c};border-color:${c};color:${textOn(c)}"` : ''; };
const kwChip = (k, hit) => `<button class="kw${hit ? ' hit' : ''}" data-kw="${esc(k)}"${kwStyle(k)}>${esc(k)}</button>`;

/* ---------- 검색 ---------- */
// 한글 자모 분리형(NFD)·특수 공백이 섞여 있어도 같은 글자로 비교하도록 정규화
const norm = t => String(t ?? '').normalize('NFC').replace(/[\u00a0\u200b-\u200d\ufeff]/g, ' ');
/* 검색식 해석
   &  또는 AND 또는 띄어쓰기 = 모두 포함,  OR = 하나라도 포함,  ( ) = 묶음,  '…' 또는 "…" = 띄어쓰기가 있는 단어
   괄호가 없으면 AND가 OR보다 먼저 계산됩니다. (OR·AND는 대문자) */
const _pcache = new Map();
function parseQuery(raw) {
  const q = norm(raw);
  if (_pcache.has(q)) return _pcache.get(q);
  const toks = []; let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { toks.push({ t: c }); i++; continue; }
    if (c === '&') { toks.push({ t: 'AND' }); i++; continue; }
    if (c === "'" || c === '"') {
      const j = q.indexOf(c, i + 1), end = j < 0 ? q.length : j, w = q.slice(i + 1, end).trim();
      if (w) toks.push({ t: 'TERM', v: w.toLowerCase() });
      i = j < 0 ? q.length : j + 1; continue;
    }
    let j = i; while (j < q.length && !/[\s()&]/.test(q[j])) j++;
    const w = q.slice(i, j); i = j;
    toks.push(w === 'OR' ? { t: 'OR' } : w === 'AND' ? { t: 'AND' } : { t: 'TERM', v: w.toLowerCase() });
  }
  let p = 0, warn = ''; const terms = [];
  const join = (op, a, b) => !a ? b : !b ? a : { op, a, b };
  const peek = () => toks[p];
  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === 'OR') { p++; left = join('or', left, parseAnd()); }
    return left;
  }
  function parseAnd() {
    let left = parseUnary();
    for (;;) {
      const k = peek();
      if (!k) break;
      if (k.t === 'AND') { p++; left = join('and', left, parseUnary()); }
      else if (k.t === 'TERM' || k.t === '(') left = join('and', left, parseUnary());
      else break;
    }
    return left;
  }
  function parseUnary() {
    const k = peek();
    if (!k) { warn ||= '연산자 뒤에 검색어가 없습니다'; return null; }
    if (k.t === 'TERM') { p++; if (!terms.includes(k.v)) terms.push(k.v); return { op: 'term', v: k.v }; }
    if (k.t === '(') {
      p++; const e = parseOr();
      if (peek() && peek().t === ')') p++; else warn ||= "닫는 괄호 ')'가 없습니다";
      return e;
    }
    warn ||= '연산자나 괄호 위치가 올바르지 않습니다'; p++; return null;   // 엉뚱한 자리의 OR / AND / ) 는 건너뜀
  }
  let node = parseOr();
  while (p < toks.length) { warn ||= "여는 괄호 '('가 없는 ')'가 있습니다"; p++; node = join('and', node, parseOr()); }
  const res = { node, terms, warn };
  if (_pcache.size > 200) _pcache.clear();
  _pcache.set(q, res);
  return res;
}
const evalNode = (n, hay) => n.op === 'term' ? hay.includes(n.v) : n.op === 'and' ? evalNode(n.a, hay) && evalNode(n.b, hay) : evalNode(n.a, hay) || evalNode(n.b, hay);
function exprText(n, parent) {
  if (n.op === 'term') return /[\s()&]/.test(n.v) || n.v === 'or' ? `'${n.v}'` : n.v;
  const t = exprText(n.a, n.op) + (n.op === 'and' ? ' & ' : ' OR ') + exprText(n.b, n.op);
  return parent === 'and' && n.op === 'or' ? '(' + t + ')' : t;
}
const parsed = () => parseQuery(S.query);                  // 전체 폴더 검색식
const vparsed = () => parseQuery(S.vq || S.query);         // 열려 있는 영상 안의 검색식(영상 검색칸이 비면 전체 검색식)
const terms = () => parsed().terms;
const vterms = () => vparsed().terms;
const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hayOf = (v, e) => [
  S.scope.text ? e.text : '',
  S.scope.kw ? e.keywords.join(' ') : '',
  S.scope.ref ? entryRefs(v, e).map(r => r.label).join(' ') : ''].join(' ');
function entryHit(v, e, pq = vparsed()) {
  if (e.bad || !pq.node) return false;
  return evalNode(pq.node, norm(hayOf(v, e)).toLowerCase());
}
function computeHits() {
  S.hits = {};
  const pq = parsed(); if (!pq.terms.length) return;
  const re = new RegExp(pq.terms.map(reEsc).join('|'), 'gi');
  for (const v of S.videos) {
    let n = 0, occ = 0;
    for (const e of v.entries) if (entryHit(v, e, pq)) { n++; occ += (norm(hayOf(v, e)).match(re) || []).length; }
    S.hits[v.key] = { n, occ };
  }
}
function buildKwIndex() {
  S.kwIndex = new Map();
  for (const v of S.videos) for (const e of v.entries) for (const k of e.keywords || []) {
    const n = normKw(k);
    if (!S.kwIndex.has(n)) S.kwIndex.set(n, []);
    S.kwIndex.get(n).push({ v, e });
  }
}
/* ---------- 키워드로 찾기 (전체 문서의 키워드 목록) ---------- */
const kwRank = k => /[0-9]/.test(k[0]) ? 0 : /[A-Za-z]/.test(k[0]) ? 1 : /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/.test(k[0]) ? 2 : /[\p{L}]/u.test(k[0]) ? 3 : 0;
function allKeywords() {
  const out = [];
  for (const [nk, items] of S.kwIndex) {
    const freq = new Map();
    for (const { e } of items) for (const k of e.keywords) if (normKw(k) === nk) freq.set(k, (freq.get(k) || 0) + 1);
    const label = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || nk;
    out.push({ nk, label, n: items.length, vn: new Set(items.map(x => x.v.key)).size });
  }
  return out.sort((a, b) => kwRank(a.label) - kwRank(b.label) || a.label.localeCompare(b.label, 'ko', { sensitivity: 'base' }));
}
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const CHO_BASE = { 'ㄲ': 'ㄱ', 'ㄸ': 'ㄷ', 'ㅃ': 'ㅂ', 'ㅆ': 'ㅅ', 'ㅉ': 'ㅈ' };
const GROUP_ORDER = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ', '기타'];
function groupOf(label) {
  const c = [...norm(label).trim()][0] || '#', code = c.codePointAt(0);
  if (/[0-9]/.test(c)) return '#';
  if (/[A-Za-z]/.test(c)) return c.toUpperCase();
  if (code >= 0xAC00 && code <= 0xD7A3) { const ch = CHO[Math.floor((code - 0xAC00) / 588)]; return CHO_BASE[ch] || ch; }
  if (code >= 0x3130 && code <= 0x318F) return CHO_BASE[c] || (GROUP_ORDER.includes(c) ? c : '기타');
  return /\p{L}/u.test(c) ? '기타' : '#';
}
function renderKwBrowse() {
  const all = allKeywords(), f = norm($('#kwbFilter').value).toLowerCase().trim();
  const list = f ? all.filter(k => norm(k.label).toLowerCase().includes(f)) : all;
  const byCnt = S.kwbSort === 'cnt';
  $('#kwbCount').textContent = `(${all.length})`;
  $('#kwbSortName').classList.toggle('on', !byCnt); $('#kwbSortCnt').classList.toggle('on', byCnt);
  $('#kwbHint').textContent = byCnt ? '타임스탬프 수가 많은 순 · 같으면 이름순 · 숫자는 그 키워드가 적힌 타임스탬프 수'
    : '숫자·기호 → 알파벳 → 가나다 순 · 숫자는 그 키워드가 적힌 타임스탬프 수';
  const chip = k => `<span class="kwb" data-kw="${esc(k.label)}" title="${k.n}개 타임스탬프 · 영상 ${k.vn}개">${kwChip(k.label, false)}<span class="kn">${k.n}</span></span>`;
  const box = $('#kwbList'), idx = $('#kwbIdx');
  if (!list.length) {
    idx.hidden = true;
    box.className = ''; box.innerHTML = `<span class="hint">${all.length ? '일치하는 키워드가 없습니다.' : '아직 키워드가 없습니다.'}</span>`; return;
  }
  if (byCnt) {
    idx.hidden = true; box.className = 'flat';
    box.innerHTML = list.slice().sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'ko', { sensitivity: 'base' })).map(chip).join('');
    return;
  }
  const groups = new Map();
  for (const k of list) { const g = groupOf(k.label); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(k); }
  const keys = GROUP_ORDER.filter(g => groups.has(g));
  if (S.kwbGroup && !groups.has(S.kwbGroup)) S.kwbGroup = '';
  const sel = S.kwbGroup, shown = sel ? [sel] : keys;
  box.className = 'grouped';
  box.innerHTML = shown.map(g => `<div class="kwg" data-g="${esc(g)}"><span class="kgl">${esc(g)}</span><div class="kwgc">${groups.get(g).map(chip).join('')}</div></div>`).join('');
  box.scrollTop = 0;
  idx.hidden = false;
  idx.innerHTML = `<button type="button" class="ix all${sel ? '' : ' on'}" data-g="" title="모든 묶음 보기">전체</button>` +
    keys.map(g => `<button type="button" class="ix${g === sel ? ' on' : ''}" data-g="${esc(g)}" title="${groups.get(g).length}개" aria-pressed="${g === sel}">${esc(g)}</button>`).join('');
  if (sel) $('#kwbHint').textContent = `'${sel}' 묶음 ${groups.get(sel).length}개만 표시 중 · 같은 버튼을 다시 누르거나 '전체'를 누르면 해제`;
}

function hitList() {
  const v = curVideo(); if (!v) return [];
  const pq = vparsed();
  return validEntries(v).filter(e => entryHit(v, e, pq)).sort((a, b) => a.sec - b.sec || a.row - b.row);
}
function hl(text) {
  const t = vterms();
  if (!t.length || !S.scope.text) return esc(text);
  const re = new RegExp('(' + t.map(reEsc).join('|') + ')', 'gi');
  return norm(text).split(re).map((p, i) => i % 2 ? `<mark>${esc(p)}</mark>` : esc(p)).join('');
}
function updateParseInfo() {
  const pq = parsed(), box = $('#qparse');
  if (!pq.node) { box.hidden = true; return; }
  const complex = pq.node.op !== 'term';
  box.hidden = !complex && !pq.warn;
  box.innerHTML = (complex ? `<span class="pi">해석: <code>${esc(exprText(pq.node))}</code></span>` : '') + (pq.warn ? `<span class="pw">⚠ ${esc(pq.warn)} — 가능한 범위에서 해석했습니다</span>` : '');
}
function updateSummary() {
  updateParseInfo();
  const q = terms().length;
  if (!q) { $('#gsum').textContent = ''; return; }
  const hv = Object.values(S.hits).filter(h => h.n > 0);
  const stamps = hv.reduce((a, h) => a + h.n, 0);
  const nb = bmMatches().length;
  $('#gsum').textContent = (hv.length ? `영상 ${hv.length}개 · ${stamps}곳` : '결과 없음' + scopeNote()) + (nb ? ` · ★ ${nb}개` : '');
}

/* ---------- 불러오기 ---------- */
async function loadAll(auto) {
  const [lib, refs] = await Promise.all([api('/api/library'), api('/api/refs')]);
  S.lib = lib; S.refs = refs; S.stamp = lib.stamp;
  S.videos = lib.files.flatMap(f => f.videos.map(v => ({ ...v, wb: f.path })));
  S.errors = lib.files.filter(f => f.error);
  S.skipped = lib.files.reduce((a, f) => a + (f.skipped?.length || 0), 0);
  const stale = lib.version !== WEB_VERSION;
  $('#ver').textContent = 'v' + WEB_VERSION;
  $('#ver').classList.toggle('stale', stale);
  $('#ver').title = stale ? `실행 중인 서버는 v${lib.version || '?'} 입니다. 서버를 껐다가 run.bat으로 다시 실행해 주세요.` : '';
  if (stale && !S.staleToasted) { S.staleToasted = true; toast(`서버가 이전 버전(v${lib.version || '?'})으로 실행 중입니다. 서버를 종료한 뒤 run.bat을 다시 실행해 주세요.`, 9000); }
  $('#stalebar').hidden = !stale;
  if (stale) $('#stalebar').textContent = `⚠ 서버가 이전 버전(v${lib.version || '?'})으로 실행 중입니다. 상단 [종료]를 누르거나 검은 창을 닫은 뒤 run.bat을 다시 실행해 주세요.`;
  $('#libpath').textContent = lib.root; $('#libpath').title = lib.root;
  if (!S.updChecked) { S.updChecked = true; checkUpdate(); }
  buildKwIndex(); computeHits(); computeOrphans(); updateDiagBadge(); $('#bmCount').textContent = bmCountText(); updateSummary(); renderSide(); renderKwBrowse();
  if (S.selKey && !curVideo()) { S.selKey = null; S.selEntry = null; }
  const v = curVideo();
  if (v && S.selEntry && !v.entries.some(e => e.key === S.selEntry)) S.selEntry = null;
  if (!v) renderEmpty();
  else if (auto && $('#bar')) { if (!S.editing) updateAll(); }
  else renderVideo();
}

/* ---------- 사이드바 ---------- */
function dateCmp(a, b) {
  if (!a.date && !b.date) return cmp(a.title, b.title);
  if (!a.date) return 1;
  if (!b.date) return -1;
  const d = a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  return (S.sortDesc ? -d : d) || cmp(a.title, b.title);
}
function tileColor(key) {
  let h = 0; for (const ch of String(key)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `hsl(${h % 360} 45% 86%)`;
}
function vItem(v, showWb) {
  const q = terms().length, h = S.hits[v.key];
  const th = `<span class="th ico" data-ik="video" data-ip="${esc(v.key)}" title="아이콘 변경" style="background:${tileColor(v.key)}">${esc(iconOf('video', v.key))}</span>`;
  const badge = q && h?.n ? `<span class="hc" title="${h.n}개 타임스탬프에서 단어 ${h.occ}회 일치">${h.n}</span>` : '';
  return `<div class="vi ${v.key === S.selKey ? 'on' : ''} ${q && !h?.n ? 'nohit' : ''}" data-key="${esc(v.key)}">${th}<div class="vtx">
    <div class="vd">${esc(v.dateText || '날짜 없음')}</div><div class="vt">${esc(v.title)}</div>
    ${showWb ? `<div class="vw">${esc(v.wb)}</div>` : ''}</div>${badge}<button type="button" class="vmore" data-vm="${esc(v.key)}" title="영상 메뉴 (이름 변경 · 위치 이동 · 삭제)" aria-label="영상 메뉴" aria-haspopup="menu">⋯</button></div>`;
}
/* 폴더·엑셀 파일 아이콘(이모지) — 아이콘을 누르면 바꿀 수 있습니다 */
const ICON_DEFAULT = { dir: '📁', file: '📒', video: '▶' };
const iconOf = (kind, path) => S.refs.icons?.[kind + ':' + path] || ICON_DEFAULT[kind];
const icoSpan = (kind, path) => `<span class="ico" data-ik="${kind}" data-ip="${esc(path)}" title="아이콘 변경">${esc(iconOf(kind, path))}</span>`;
function renderNode(node, prefix = '') {
  let h = '';
  for (const name of Object.keys(node.f).sort(cmp)) {
    const p = prefix + name;
    h += `<details open><summary class="fold">${icoSpan('dir', p)} ${esc(name)}<button class="sbadd" data-newdoc="${esc(p)}" title="이 폴더에 새 엑셀 문서 만들기">＋</button></summary><div class="ind">${renderNode(node.f[name], p + '/')}</div></details>`;
  }
  for (const name of Object.keys(node.w).sort(cmp)) {
    const vs = node.w[name].slice().sort(dateCmp), p = prefix + name;
    h += `<details open><summary class="fold">${icoSpan('file', p)} ${esc(name.replace(/\.xlsx$/i, ''))}<span class="cnt">${vs.length}</span><button class="sbadd" data-addv="${esc(p)}" title="이 문서에 영상(시트) 추가">＋</button></summary><div class="ind">${vs.length ? vs.map(v => vItem(v, false)).join('') : '<div class="hint" style="padding:2px 8px">영상이 없습니다. ＋ 로 추가하세요.</div>'}</div></details>`;
  }
  return h;
}
const EMOJI_SET = ['📁','📂','📒','📓','📔','📕','📗','📘','📙','📚','🎮','🕹️','🎬','🎞️','📺','🎵','🎧','🎨','🍳','🍜','🍰','☕','⚽','🏀','💪','🏃','✈️','🏖️','🚗','💻','⌨️','🖥️','📱','📷','🔬','🧪','🧠','📝','✏️','📌','⭐','❤️','🔥','🌙','☀️','🌸','🐱','🐶','🦊','🐉','⚔️','🛡️','👑','💎','🎁','🔒','💡','🎯','🧩','🌍'];
const firstGlyph = t => {
  t = String(t || '').trim(); if (!t) return '';
  try { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)][0].segment; }
  catch { return Array.from(t)[0]; }
};
function openIconPicker(kind, path) {
  const dlg = $('#icopick'), key = kind + ':' + path;
  const vid = kind === 'video' ? S.videos.find(x => x.key === path) : null;
  const name = vid ? vid.title : path.split('/').pop().replace(/\.xlsx$/i, '');
  $('#icoTitle').textContent = `${kind === 'dir' ? '폴더' : kind === 'video' ? '영상' : '파일'} 아이콘 — ${name}`;
  $('#icoGrid').innerHTML = EMOJI_SET.map(e => `<button class="em" data-e="${esc(e)}">${esc(e)}</button>`).join('');
  const inp = $('#icoInput'); inp.value = S.refs.icons?.[key] || '';
  const apply = async glyph => {
    (S.refs.icons ??= {});
    if (glyph) S.refs.icons[key] = glyph; else delete S.refs.icons[key];
    await persist(); renderSide();
  };
  $('#icoGrid').onclick = async ev => { const b = ev.target.closest('.em'); if (!b) return; inp.value = b.dataset.e; await apply(b.dataset.e); dlg.close(); };
  inp.oninput = () => { /* 입력 중에는 미리보기만 */ $('#icoPrev').textContent = firstGlyph(inp.value) || ICON_DEFAULT[kind]; };
  inp.oninput();
  $('#icoOk').onclick = async () => { await apply(firstGlyph(inp.value)); dlg.close(); };
  $('#icoReset').onclick = async () => { inp.value = ''; await apply(''); dlg.close(); };
  $('#icoClose').onclick = () => dlg.close();
  inp.onkeydown = ev => { if (ev.isComposing) return; if (ev.key === 'Enter') { ev.preventDefault(); $('#icoOk').click(); } };
  dlg.showModal(); inp.focus(); inp.select();
}
function renderSide() {
  closeVMenu();
  const q = terms().length;
  const list = (q && S.onlyHit) ? S.videos.filter(v => S.hits[v.key]?.n > 0) : S.videos;
  let html = '';
  if (S.mode === 'flat') {
    html = list.slice().sort(dateCmp).map(v => vItem(v, true)).join('');
  } else {
    const root = { f: {}, w: {} };
    for (const v of list) {
      const parts = v.wb.split('/'); let n = root;
      for (const p of parts.slice(0, -1)) n = (n.f[p] ??= { f: {}, w: {} });
      (n.w[parts.at(-1)] ??= []).push(v);
    }
    if (!q) for (const f of S.lib.files) {          // 영상이 아직 없는 새 문서도 보이게 (＋ 로 영상 추가)
      if (f.error || f.videos.length || /템플릿|template/i.test(f.path.split('/').at(-1))) continue;
      const parts = f.path.split('/'); let n = root;
      for (const p of parts.slice(0, -1)) n = (n.f[p] ??= { f: {}, w: {} });
      n.w[parts.at(-1)] ??= [];
    }
    html = (q ? '' : `<div class="sbroot"><button class="btn sm" data-newdoc="">＋ 새 엑셀 문서</button> <button class="btn sm" data-import="1" title="다른 사람이 만든 엑셀에서 타임라인(시간·내용·키워드)을 골라 가져옵니다">📥 다른 엑셀 불러오기</button></div>`) + renderNode(root);
  }
  if (S.errors.length) html += `<div class="sideerr">${S.errors.map(f => `⚠ ${esc(f.path)}<br>${esc(f.error)}`).join('<hr>')}</div>`;
  const sec = q ? bmSection() : '';
  $('#side').innerHTML = sec + (html || `<div class="hint" style="padding:12px">${q ? '검색 결과가 있는 영상이 없습니다.' : '영상이 없습니다.'}</div>`);
  $('#btnSort').textContent = S.sortDesc ? '업로드일 ↓ 최신순' : '업로드일 ↑ 오래된순';
  $('#btnMode').textContent = S.mode === 'tree' ? '보기: 폴더별' : '보기: 날짜순 전체';
}

/* ---------- 본문 ---------- */
function renderEmpty() {
  $('#main').innerHTML = `<div class="empty"><h2>왼쪽에서 영상을 선택하세요</h2>
    ${S.videos.length ? '' : `<p>아직 읽을 영상이 없습니다. 아래 폴더 안에 엑셀(.xlsx) 파일을 넣어 주세요.<br><code>${esc(S.lib?.root || '')}</code></p>`}
    ${S.skipped ? `<p>템플릿으로 보고 제외한 시트가 ${S.skipped}개 있습니다.<br>시트 이름이 <b>'템플릿'이나 'Template'</b>이면 내용이 있어도 항상 제외됩니다. 그 밖에 이름에 '템플릿'이 들어간 시트는 <b>영상 제목(B1)이나 주소(B2)를 입력</b>하면 영상으로 표시됩니다.</p>` : ''}
    <p>엑셀 한 파일은 폴더처럼, 시트 하나는 영상 하나로 인식합니다.<br>
    B1 제목 · B2 영상 주소 · B3 업로드 일자, 4행 머리글(타임라인 | 내용 | 키워드) 아래로 시간 · 내용 · 키워드(오른쪽으로 계속)를 입력</p></div>`;
}
function openVideo(key, entryKey) {
  if (S.editing) return toast('내용 수정 중입니다. 저장 또는 취소를 먼저 해 주세요.');
  closeKwPop();
  if (key === S.selKey && $('#bar')) {          // 이미 열려 있는 영상이면 플레이어를 다시 불러오지 않고 항목만 선택
    if (entryKey) selectEntry(entryKey);
    return;
  }
  S.selKey = key; S.selEntry = entryKey || null; S.only = false; S.vq = ''; S.zoom = null;
  document.querySelectorAll('.vi.on').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('.vi').forEach(x => { if (x.dataset.key === key) x.classList.add('on'); });
  renderVideo();
  $('#main').scrollTop = 0;
}
function renderVideo() {
  const v = curVideo();
  if (!v) return renderEmpty();
  $('#main').innerHTML = `
    <div id="vtop"><div id="ytbox"></div><div id="vinfo"></div></div>
    <div class="card">
      <div class="searchrow">
        <span class="ctitle" style="margin:0">타임라인 막대</span><button class="btn sm" id="addEnt">＋ 타임라인 추가</button><span class="sp"></span>
        <input id="vq" class="vq" placeholder="🔍 이 영상 안에서 검색" autocomplete="off">
        <span id="qcnt"></span>
        <button class="btn sm" id="prev" title="이전 결과 (Shift+Enter)">▲</button>
        <button class="btn sm" id="next" title="다음 결과 (Enter)">▼</button>
        <label class="chk"><input type="checkbox" id="only"> 일치 항목만 목록에 표시</label>
      </div>
      <div class="tl"><div id="stars"></div><div id="arrows"></div><div id="bar"></div><div id="axis"></div></div>
      <div class="zoomrow">
        <span class="lb">확대·축소</span>
        <button class="btn sm" id="zout" title="축소">－</button><button class="btn sm" id="zin" title="확대">＋</button>
        <button class="btn sm" id="zreset" title="전체 구간 보기">전체</button>
        <span id="zinfo"></span>
        <span class="zhint">막대 위에서 마우스 휠 = 확대/축소 · 확대 후 끌어서 이동</span>
      </div>
      <input type="range" id="zpan" hidden min="0" max="1" value="0" title="보는 구간 이동">
      <div class="durrow">재생 시간 <input id="dur" placeholder="0:00:00"> <button class="btn sm" id="durAuto">자동</button><span id="durNote"></span></div>
    </div>
    <div class="card" id="detail"></div>
    <div class="card"><div class="lhead"><div class="ctitle" id="ltitle"></div>
      <button class="btn sm" id="openAll">모두 펼치기</button><button class="btn sm" id="closeAll">모두 접기</button></div>
      <div id="list"></div></div>`;
  $('#only').checked = S.only;
  $('#vq').value = S.vq;
  $('#vq').oninput = () => { S.vq = $('#vq').value; S.selEntry = (hitList()[0] || validEntries(curVideo())[0])?.key ?? S.selEntry; updateAll(); };
  $('#vq').onkeydown = e => {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { $('#vq').value = ''; $('#vq').oninput(); }
  };
  $('#prev').onclick = () => stepHit(-1);
  $('#next').onclick = () => stepHit(1);
  $('#only').onchange = () => { S.only = $('#only').checked; updateList(); };
  $('#addEnt').onclick = () => openAddEntry(v);
  $('#openAll').onclick = () => { for (const e of v.entries) S.toggle.set(v.key + '|' + e.key, true); updateList(); };
  $('#closeAll').onclick = () => { for (const e of v.entries) S.toggle.set(v.key + '|' + e.key, false); updateList(); };
  $('#zin').onclick = () => zoomBy(1.6);
  $('#zout').onclick = () => zoomBy(1 / 1.6);
  $('#zreset').onclick = () => { S.zoom = null; updateBar(); };
  $('#zpan').oninput = () => { const vv = curVideo(), [a, b] = viewRange(vv); setView(vv, +$('#zpan').value, +$('#zpan').value + (b - a)); };
  const barWrap = $('#bar').parentElement;
  barWrap.addEventListener('wheel', ev => {
    if (!ev.target.closest('#bar, #stars, #arrows, #axis')) return;
    ev.preventDefault();
    const r = $('#bar').getBoundingClientRect();
    zoomBy(ev.deltaY < 0 ? 1.25 : 1 / 1.25, Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1));
  }, { passive: false });
  let drag = null;
  $('#bar').addEventListener('mousedown', ev => {
    if (ev.button !== 0 || !S.zoom) return;
    const vv = curVideo(), [a, b] = viewRange(vv);
    drag = { x: ev.clientX, a, span: b - a, moved: false, w: $('#bar').getBoundingClientRect().width };
  });
  window.addEventListener('mousemove', ev => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    if (Math.abs(dx) > 4) drag.moved = true;
    if (drag.moved) { const vv = curVideo(); if (vv) { const sh = -dx / drag.w * drag.span; setView(vv, drag.a + sh, drag.a + sh + drag.span); } }
  });
  window.addEventListener('mouseup', () => { if (drag) { const moved = drag.moved; drag = null; if (moved) S.justDragged = true; setTimeout(() => { S.justDragged = false; }, 0); } });
  $('#bar').onclick = ev => {
    if (S.justDragged) return;
    const vv = curVideo(); const es = validEntries(vv); if (!es.length) return;
    const r = $('#bar').getBoundingClientRect(), [va, vb] = viewRange(vv);
    const t = va + (ev.clientX - r.left) / r.width * (vb - va);
    let pick = es[0];
    for (const e of es) { if (e.sec <= t) pick = e; else break; }
    selectEntry(pick.key, true);
  };
  $('#stars').onclick = ev => { const a = ev.target.closest('.bkm'); if (a) selectEntry(a.dataset.k, true); };
  $('#arrows').onclick = ev => { const a = ev.target.closest('.arw'); if (a) selectEntry(a.dataset.k, true); };
  $('#dur').onchange = async () => {
    const vv = curVideo(), val = $('#dur').value.trim();
    if (!val) return;
    const sec = parseTime(val), last = lastSec(vv);
    if (sec == null || sec <= 0) { toast('시간 형식을 확인해 주세요 (예: 1:23:45)'); return updateAll(); }
    if (sec < last) { toast('마지막 타임스탬프(' + fmt(last) + ')보다 짧을 수 없습니다'); return updateAll(); }
    (S.refs.videos[vv.key] ??= {}).duration = sec;
    await persist(); updateAll();
  };
  $('#durAuto').onclick = async () => {
    const vv = curVideo();
    if (S.refs.videos[vv.key]) delete S.refs.videos[vv.key].duration;
    await persist(); updateAll();
  };
  if (!S.selEntry) S.selEntry = (hitList()[0] || validEntries(v)[0])?.key ?? null;
  mountPlayer(v);
  updateAll();
}

function stepHit(dir) {
  const hs = hitList(); if (!hs.length) return;
  let i = hs.findIndex(e => e.key === S.selEntry);
  i = i < 0 ? (dir > 0 ? 0 : hs.length - 1) : (i + dir + hs.length) % hs.length;
  selectEntry(hs[i].key);
}
function selectEntry(key, focus) {
  if (S.editing) return toast('내용 수정 중입니다. 저장 또는 취소를 먼저 해 주세요.');
  S.selEntry = key; const vv = curVideo(); if (vv) ensureVisible(vv, vv.entries.find(x => x.key === key)); updateAll(); scrollSel(focus);
}
function scrollSel(focus) {
  const row = $('#list .row.sel'); if (!row) return;
  const list = $('#list'), main = $('#main');
  if (focus) {                                  // 막대·화살표·★·검색결과로 이동: 목록(안쪽 스크롤) 맨 윗줄에 오도록 부드럽게
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches, behavior = calm ? 'auto' : 'smooth';
    list.scrollTo({ top: Math.max(0, list.scrollTop + row.getBoundingClientRect().top - list.getBoundingClientRect().top - 4), behavior });
    // 목록 자체가 화면 밖이면 바깥 화면을 최소한만 움직여 목록 윗부분이 보이게 (막대·본문이 함께 보이도록 가운데쯤에 맞춤)
    const lr = list.getBoundingClientRect(), mr = main.getBoundingClientRect();
    if (lr.top < mr.top + 60 || lr.top > mr.bottom - 160) main.scrollBy({ top: lr.top - (mr.top + mr.height * 0.45), behavior });
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  } else row.scrollIntoView({ block: 'nearest' });
}

function updateAll() {
  if (!curVideo() || !$('#bar')) return;
  updateHead(); updateBar(); updateDetail(); updateList(); updateCount();
}
function updateHead() {
  const v = curVideo();
  const jump = v.url ? normUrl(v.url) : '';
  $('#vinfo').innerHTML = `<div class="vtitle">${esc(v.title)}</div><div class="vmeta">
    <span>업로드 ${esc(v.dateText || '-')}</span><span>${esc(v.wb)} › ${esc(v.sheet)}</span>
    ${v.url ? `<a href="${esc(jump)}" target="_blank" rel="noopener" title="재생이 안 되는 영상(임베드 금지)은 유튜브에서 여세요">유튜브에서 열기 ↗</a>` : '<span class="warn">영상 주소(B2)가 없습니다</span>'}</div>
    <div class="ytnote">이 프로그램은 YouTube API Services(임베드 플레이어)를 사용합니다.
      <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener">YouTube 서비스 약관</a> ·
      <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google 개인정보처리방침</a> ·
      <a href="#" id="ytInfoLink">이용 안내</a></div>`;
  $('#ytInfoLink').onclick = ev => { ev.preventDefault(); openInfo(); };
}
/* 임베드 플레이어: 영상을 열 때 한 번만 만들고, 화면이 갱신되어도 다시 불러오지 않습니다 */
/* 유튜브 IFrame Player API — 재생 위치를 읽기 위해 사용합니다. 불러오지 못하면 일반 임베드로만 동작합니다. */
let ytApiP = null;
function loadYtApi() {
  if (window.YT && YT.Player) return Promise.resolve(true);
  if (ytApiP) return ytApiP;
  ytApiP = new Promise(res => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { try { prev && prev(); } catch { /* 무시 */ } res(true); };
    const sc = document.createElement('script'); sc.src = 'https://www.youtube.com/iframe_api'; sc.onerror = () => res(false);
    document.head.appendChild(sc);
    setTimeout(() => res(!!(window.YT && YT.Player)), 8000);
  });
  return ytApiP;
}
function mountPlayer(v) {
  const id = ytId(v.url), box = $('#ytbox');
  S.player = null; S.playerReady = false;
  box.innerHTML = id
    ? `<iframe src="${embedUrl(id, 0, false)}" title="YouTube 영상 플레이어" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`
    : '<div class="noplayer">영상 주소(B2)가 없거나 유튜브 주소가 아니라서<br>플레이어를 표시할 수 없습니다.</div>';
  const f = box.querySelector('iframe'); if (!f) return;
  loadYtApi().then(ok => {
    if (!ok || !f.isConnected || !(window.YT && YT.Player)) return;   // 실패해도 일반 임베드는 그대로 동작
    try { const p = new YT.Player(f, { events: { onReady: () => { if (f.isConnected) { S.player = p; S.playerReady = true; } } } }); } catch { /* 무시 */ }
  });
}
// 플레이어의 현재 재생 위치(초). 재생해 본 적이 없거나 읽을 수 없으면 null.
function playerSec() {
  const p = S.player; if (!p || !S.playerReady || typeof p.getCurrentTime !== 'function') return null;
  try {
    const st = p.getPlayerState();                       // -1 시작 전, 0 종료, 1 재생, 2 일시정지, 3 버퍼링, 5 대기
    if (st === -1 || st === 5) return null;
    const t = p.getCurrentTime(); return Number.isFinite(t) ? Math.floor(t) : null;
  } catch { return null; }
}
function playAt(sec) {
  const v = curVideo(), id = v && ytId(v.url), f = $('#ytbox iframe');
  if (!id || !f) return toast('이 영상은 유튜브 주소가 없어 재생할 수 없습니다.');
  const p = S.player;
  if (p && S.playerReady && typeof p.seekTo === 'function') {
    try { p.seekTo(sec, true); p.playVideo(); } catch { f.src = embedUrl(id, sec, true); }
  } else f.src = embedUrl(id, sec, true);
  $('#ytbox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function scopeNote() {
  const n = [S.scope.text && '본문', S.scope.kw && '키워드', S.scope.ref && '참고자료'].filter(Boolean);
  return n.length === 3 ? '' : ` (검색 범위: ${n.join('·')}만)`;
}
function updateCount() {
  const hs = hitList(), q = vterms().length;
  const i = hs.findIndex(e => e.key === S.selEntry);
  $('#qcnt').textContent = q ? (hs.length ? `이 영상 ${i >= 0 ? i + 1 : '-'} / ${hs.length}` : '이 영상엔 결과 없음' + scopeNote()) : '';
}
/* ---------- 막대 확대·축소 ---------- */
const MIN_SPAN = 10;   // 가장 많이 확대했을 때 보이는 구간(초)
function viewRange(v) {
  const dur = duration(v), z = S.zoom;
  if (!z || z.k !== v.key) return [0, dur];
  const span = Math.min(Math.max(z.e - z.s, Math.min(MIN_SPAN, dur)), dur);
  const st = Math.min(Math.max(z.s, 0), dur - span);
  return [st, st + span];
}
function setView(v, a, b) {
  const dur = duration(v);
  let span = Math.min(Math.max(b - a, Math.min(MIN_SPAN, dur)), dur);
  let st = Math.min(Math.max(a, 0), dur - span);
  S.zoom = span >= dur - 0.5 ? null : { k: v.key, s: st, e: st + span };
  updateBar();
}
function zoomBy(factor, centerFrac = 0.5) {
  const v = curVideo(); if (!v) return;
  const [a, b] = viewRange(v), span = b - a, c = a + span * centerFrac;
  const ns = span / factor;
  setView(v, c - ns * centerFrac, c + ns * (1 - centerFrac));
}
function ensureVisible(v, e) {
  const [a, b] = viewRange(v); if (!S.zoom || !e || e.bad) return;
  if (e.sec >= a && e.sec <= b) return;
  const span = b - a; setView(v, e.sec - span / 2, e.sec + span / 2);
}
function updateBar() {
  const v = curVideo(), es = validEntries(v), dur = duration(v), q = terms().length;
  const [vs, ve] = viewRange(v), span = ve - vs;
  const hs = new Set(hitList().map(e => e.key));
  $('#bar').innerHTML = es.map((e, i) => {
    const nx = i + 1 < es.length ? es[i + 1].sec : dur;
    let l = (e.sec - vs) / span * 100, r = (nx - vs) / span * 100;
    if (r <= 0 || l >= 100) return '';
    l = Math.max(l, 0); r = Math.min(r, 100);
    const w = Math.max(r - l, 0.2);
    const hit = hs.has(e.key);
    const snip = (e.keywords.length ? '[' + e.keywords.join(', ') + '] ' : '') + e.text.replace(/\s+/g, ' ').slice(0, 60);
    return `<div class="seg ${i % 2 ? 'b' : 'a'} ${hit ? 'hit' : ''} ${q && !hit ? 'dim' : ''} ${e.key === S.selEntry ? 'sel' : ''}" style="left:${l}%;width:${w}%" title="${esc(fmt(e.sec) + '  ' + snip)}"></div>`;
  }).join('');
  $('#arrows').innerHTML = es.filter(e => hs.has(e.key) && e.sec >= vs && e.sec <= ve)
    .map(e => `<div class="arw" data-k="${esc(e.key)}" style="left:${(e.sec - vs) / span * 100}%" title="${esc(fmt(e.sec))}">▼</div>`).join('');
  // 즐겨찾기가 걸린 타임스탬프 위치에 ★ (막대 바로 위, 검색 화살표 ▼보다 위줄)
  $('#stars').innerHTML = es.map(e => [e, bmFind(v.key, e.key)]).filter(([e, b]) => b && e.sec >= vs && e.sec <= ve)
    .map(([e, b]) => `<div class="bkm" data-k="${esc(e.key)}" style="left:${(e.sec - vs) / span * 100}%" title="${esc('★ ' + b.name + '  ·  ' + fmt(e.sec))}">★</div>`).join('');
  $('#axis').innerHTML = [0, 1, 2, 3, 4, 5].map(i => `<span style="left:${i * 20}%">${fmt(vs + span * i / 5)}</span>`).join('');
  // 확대 컨트롤 상태
  const zoomed = !!S.zoom && S.zoom.k === v.key;
  $('#zinfo').textContent = zoomed ? `보는 구간 ${fmt(vs)} – ${fmt(ve)}  (×${(dur / span).toFixed(1)})` : '전체 구간';
  $('#zreset').disabled = !zoomed; $('#zout').disabled = !zoomed;
  $('#zin').disabled = span <= Math.min(MIN_SPAN, dur) + 0.01;
  const pan = $('#zpan'); pan.hidden = !zoomed;
  if (zoomed) { pan.max = String(Math.max(dur - span, 1)); pan.step = String(Math.max(span / 50, 0.5)); if (document.activeElement !== pan) pan.value = String(vs); }
  const d = $('#dur'), fromXlsx = !!excelDur(v);
  if (document.activeElement !== d) d.value = fmt(dur);
  d.disabled = $('#durAuto').disabled = fromXlsx;
  $('#durNote').textContent = fromXlsx ? '(엑셀의 재생 시간 칸에서 읽음)'
    : v.duration ? `(엑셀 재생 시간 ${fmt(v.duration)}이 마지막 타임스탬프보다 짧아 무시했습니다)`
    : hasCustomDuration(v) ? '(직접 지정)' : '(자동 계산 — 엑셀의 재생 시간 칸에 입력하면 막대가 정확해집니다)';
}
function kwChips(v, e) {
  const t = vterms();
  return e.keywords.map(k => kwChip(k, S.scope.kw && t.length && t.some(x => norm(k).toLowerCase().includes(x)))).join('');
}
function updateDetail() {
  const v = curVideo(), e = curEntry(), box = $('#detail');
  if (!e || e.bad) { box.innerHTML = '<div class="hint">막대를 클릭하거나 아래 목록에서 항목을 선택하면 메모가 표시됩니다.</div>'; return; }
  const link = jumpUrl(v.url, e.sec), refs = entryRefs(v, e);
  box.innerHTML = `
    <div class="dhead"><span class="tbadge">${fmt(e.sec)}</span>${starBtn(v, e).replace('class="star', 'id="detStar" class="btn sm star')}
      <button class="btn pri" id="playhere">▶ 여기서 재생 (${fmt(e.sec)})</button>
      ${link ? `<a class="btn sm" href="${esc(link)}" target="_blank" rel="noopener" title="유튜브 사이트에서 이 시간으로 열기">유튜브에서 열기 ↗</a>` : ''}</div>
    <div class="dkws" id="kwbox">${kwChips(v, e)}${e.keywords.length ? '' : '<span class="hint">키워드 없음</span>'}<button class="btn sm" id="kwedit" title="이 타임스탬프의 키워드를 추가·삭제합니다">＋ 키워드 편집</button></div>
    <div id="memoHost"><div class="memohead"><div class="memo">${e.text ? hl(e.text) : '<span class="hint">(메모 없음)</span>'}</div>
      <button class="btn sm" data-edit>✎ 내용 수정</button></div></div>
    <div class="rtitle">${PLACE_ICON} 참고자료</div>
    <div class="chips">
      ${refs.map((r, i) => `<span class="chip ${r.missing ? 'miss' : ''}">
        <button class="o" data-open="${i}" title="${esc(r.path)}">${PLACE_ICON}${esc(r.label)}${r.missing ? ' ⚠' : ''}</button>
        <button class="x" data-ren="${i}" title="이름 변경">✎</button><button class="x" data-del="${i}" title="연결 해제">×</button></span>`).join('')}
      <button class="btn sm" id="addref">＋ 파일 연결</button>
    </div>`;
  $('#detStar').onclick = () => bmOpen(bmInfo(v, e));
  $('#addref').onclick = addRefs;
  $('#playhere').onclick = () => playAt(e.sec);
  $('#kwedit').onclick = () => startKwEdit($('#kwbox'), v, e);
  box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openViewer(+b.dataset.open));
  box.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => renameRef(+b.dataset.ren));
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => delRef(+b.dataset.del));
}
function isOpen(v, e) {
  const id = v.key + '|' + e.key;
  if (S.toggle.has(id)) return S.toggle.get(id);
  const pq = vparsed();
  return !!pq.terms.length && S.scope.text && entryHit(v, e, pq) && pq.terms.some(x => norm(e.text).toLowerCase().includes(x));  // 본문에서 일치하면 자동 펼침
}
const starBtn = (v, e) => { const b = bmFind(v.key, e.key); return `<button class="star${b ? ' on' : ''}" data-star title="${b ? '즐겨찾기 편집/삭제: ' + esc(b.name) : '즐겨찾기에 추가'}">${b ? '★' : '☆'}</button>`; };
function updateList() {
  const v = curVideo(), pq = vparsed(), q = pq.terms.length;
  let es = v.entries;
  if (S.only && q) es = es.filter(e => entryHit(v, e, pq));
  $('#ltitle').textContent = `타임라인 (${v.entries.length}개)`;
  const lbox = $('#list'), keepTop = lbox.scrollTop;
  lbox.innerHTML = es.map(e => {
    if (e.bad) return `<div class="row bad" data-k="${esc(e.key)}"><div class="rowtop"><span class="t">⚠ ${esc(e.rawTime || '?')}</span><span class="m">시간 형식을 읽을 수 없습니다 (엑셀 ${e.row}행) ${esc(e.text)}</span></div></div>`;
    const n = entryRefs(v, e).length, open = isOpen(v, e);
    return `<div class="row ${e.key === S.selEntry ? 'sel' : ''} ${entryHit(v, e, pq) ? 'hit' : ''} ${open ? 'open' : ''}" data-k="${esc(e.key)}">
      <div class="rowtop">${starBtn(v, e)}<button class="tg" data-tg title="내용 펼치기/접기">${open ? '▾' : '▸'}</button>
        <span class="t">${fmt(e.sec)}</span>
        <span class="kws">${e.keywords.length ? kwChips(v, e) : '<span class="nokw">키워드 없음</span>'}</span>
        ${n ? `<span class="rc">📎 ${n}</span>` : ''}</div>
      ${open ? `<div class="rowbody"><div class="rowmemo">${e.text ? hl(e.text) : '<span class="hint">(메모 없음)</span>'}</div><button class="btn sm" data-edit>✎ 내용 수정</button></div>` : ''}</div>`;
  }).join('') || '<div class="hint">표시할 항목이 없습니다.</div>';
  lbox.classList.remove('pad'); lbox.scrollTop = keepTop;
  lbox.classList.toggle('pad', lbox.scrollHeight > lbox.clientHeight + 4);     // 넘칠 때만 끝에 여백(마지막 줄도 맨 위로 올 수 있게)
  lbox.style.setProperty('--lh', lbox.clientHeight + 'px');
}

/* ---------- 내용 수정 (엑셀 C열에 저장) ---------- */
function startEdit(host, v, e) {
  if (S.editing) return;
  S.editing = true;
  host.innerHTML = `<textarea class="ed"></textarea><div class="edbar"><span class="edmsg"></span>
    <button class="btn sm" data-c>취소</button><button class="btn pri sm" data-s>엑셀에 저장</button></div>`;
  const ta = host.querySelector('textarea'), msg = host.querySelector('.edmsg'), save = host.querySelector('[data-s]');
  ta.value = e.text;
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight + 4, 90), 420) + 'px'; };
  ta.oninput = fit; fit(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  const end = () => { S.editing = false; updateAll(); };
  host.querySelector('[data-c]').onclick = end;
  save.onclick = async () => {
    if (ta.value.trim() === e.text.trim()) return end();
    save.disabled = true; msg.textContent = '저장 중…';
    try {
      await api('/api/entry/save', { file: v.wb, sheet: v.sheet, row: e.row, text: ta.value, expected: e.text });
      S.editing = false; toast('엑셀에 저장했습니다.');
      await loadAll(true);
    } catch (err) { msg.textContent = err.message; save.disabled = false; }
  };
  ta.onkeydown = ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); end(); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save.click(); }
  };
}

/* ---------- 타임라인 추가 (엑셀에 새 행 삽입) ---------- */
function openAddEntry(v) {
  if (S.editing) return toast('다른 수정이 진행 중입니다. 저장 또는 취소를 먼저 해 주세요.');
  const d = $('#addent'); const sel = v.entries.find(x => x.key === S.selEntry);
  const ps = playerSec();                       // 플레이어를 재생·정지해 본 적이 있으면 그 위치를 기본값으로
  const t0 = ps != null ? ps : (sel && sel.sec != null ? sel.sec : 0);
  d.innerHTML = `<form method="dialog" class="bmform"><h3>타임라인 추가</h3>
    <label>시간 <input id="aeT" value="${fmt(t0)}" autocomplete="off" placeholder="1:23:45 또는 유튜브 타임스탬프 링크 붙여넣기"></label>
    <label>내용 <textarea id="aeX" rows="4"></textarea></label>
    <label>키워드 <input id="aeK" autocomplete="off" placeholder="쉼표로 여러 개"></label>
    <div class="hint" id="aeH">${ps != null ? `플레이어의 현재 위치(${fmt(ps)})로 채웠습니다. ` : ''}시간 순서에 맞는 위치에 새 행으로 끼워 넣습니다. 시트에 수식·표·개체가 있거나 시간순이 아니면 맨 아래에 추가합니다.</div>
    <div class="edbar"><span class="edmsg" id="aeM"></span><button class="btn sm" value="cancel" type="button" id="aeC">취소</button><button class="btn pri sm" type="button" id="aeS">엑셀에 추가</button></div></form>`;
  d.showModal(); $('#aeX').focus();
  $('#aeC').onclick = () => d.close();
  d.addEventListener('close', closeKwSug, { once: true });
  {
    const ki = $('#aeK'), parts = () => ki.value.split(/[,，]/), done = () => parts().slice(0, -1).map(x => x.trim()).filter(Boolean);
    attachKwSuggest(ki, {
      getTaken: done, lastToken: () => parts().at(-1),
      pick: label => { ki.value = [...done(), label].join(', ') + ', '; ki.focus(); ki.dispatchEvent(new Event('input')); },
    });
  }
  const convert = () => {                    // 시간 칸에 유튜브 링크가 들어오면 H:MM:SS로 바꿈
    const inp = $('#aeT'), lt = linkTime(inp.value); if (!lt) return;
    if (lt.sec == null) { $('#aeM').textContent = '링크에서 시간(t=)을 찾지 못했습니다'; return; }
    inp.value = fmt(lt.sec);
    const vid = ytId(v.url);
    $('#aeM').textContent = lt.id && vid && lt.id !== vid ? '⚠ 이 영상과 다른 영상의 링크입니다. 시간을 확인해 주세요' : (lt.hasT ? '링크의 시간으로 변환했습니다' : '링크에 시간이 없어 0:00:00으로 넣었습니다');
    $('#aeX').focus();
  };
  $('#aeT').addEventListener('paste', () => setTimeout(convert, 0));
  $('#aeT').addEventListener('change', convert);
  $('#aeS').onclick = async () => {
    const msg = $('#aeM'), btn = $('#aeS');
    convert();
    const sec = parseTime($('#aeT').value);
    if (sec == null) { msg.textContent = '시간 형식을 확인해 주세요 (예: 1:23:45)'; return; }
    if (!$('#aeX').value.trim()) { msg.textContent = '내용을 입력해 주세요'; return; }
    const kws = $('#aeK').value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
    btn.disabled = true; msg.textContent = '저장 중…';
    try {
      const r = await api('/api/entry/add', { file: v.wb, sheet: v.sheet, time: fmt(sec), text: $('#aeX').value, keywords: kws });
      d.close();
      await loadAll(true);
      const nv = S.videos.find(x => x.key === v.key);
      const ne = nv && nv.entries.find(x => x.row === r.row);
      if (ne) selectEntry(ne.key, true);
      toast(r.mode === 'insert' ? `엑셀 ${r.row}행에 끼워 넣었습니다.` : `엑셀 맨 아래(${r.row}행)에 추가했습니다. (${r.reason})`, 6000);
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
}


/* ---------- 키워드 자동완성·추천 (이미 있는 키워드를 입력창 아래에 제안) ---------- */
const choStr = t => [...norm(t)].map(c => { const k = c.codePointAt(0); return k >= 0xAC00 && k <= 0xD7A3 ? CHO[Math.floor((k - 0xAC00) / 588)] : c; }).join('');
let kwSug = null;
function closeKwSug() { if (kwSug) { kwSug.el.remove(); kwSug = null; } }
function kwSuggestList(token, taken) {
  const t = norm(token).trim().toLowerCase(), skip = new Set(taken.map(normKw));
  const pool = allKeywords().filter(k => !skip.has(k.nk)).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'ko'));
  if (!t) return { head: '자주 쓰는 키워드', items: pool.slice(0, 8) };
  const jamo = /^[ㄱ-ㅎ]+$/.test(t);
  const hits = pool.map(k => {
    const l = norm(k.label).toLowerCase(); let r = -1;
    if (l === t) r = 0; else if (l.startsWith(t)) r = 1; else if (l.includes(t)) r = 2;
    else if (jamo && choStr(l).startsWith(t)) r = 3; else if (jamo && choStr(l).includes(t)) r = 4;
    return { k, r };
  }).filter(x => x.r >= 0).sort((a, b) => a.r - b.r || b.k.n - a.k.n);
  return { head: '이미 있는 키워드', items: hits.slice(0, 8).map(x => x.k) };
}
/* input: 입력창 · getTaken(): 이미 고른 키워드들 · lastToken(): 지금 치는 낱말 · pick(label): 선택했을 때 */
function attachKwSuggest(input, { getTaken, lastToken, pick }) {
  let idx = -1, items = [];
  const place = () => {
    if (!kwSug) return; const r = input.getBoundingClientRect(), el = kwSug.el;
    el.style.minWidth = Math.max(r.width, 220) + 'px'; el.style.left = Math.min(r.left, innerWidth - 240) + 'px';
    const h = el.offsetHeight, below = r.bottom + 2;
    el.style.top = (below + h > innerHeight && r.top - h - 2 > 0 ? r.top - h - 2 : below) + 'px';
  };
  const render = () => {
    const tok = lastToken(), { head, items: its } = kwSuggestList(tok, getTaken());
    items = its; idx = -1;
    if (!items.length) return closeKwSug();
    if (!kwSug) { const el = document.createElement('div'); el.className = 'kwsug'; (input.closest('dialog') || document.body).appendChild(el); kwSug = { el, input }; }
    const t = norm(tok).trim();
    kwSug.el.innerHTML = `<div class="sh">${head}${t ? '' : ' (↑↓ 선택 · Enter)'}</div>` + items.map((k, i) => {
      const l = k.label, at = t ? norm(l).toLowerCase().indexOf(t.toLowerCase()) : -1;
      const lab = at >= 0 ? esc(l.slice(0, at)) + '<b>' + esc(l.slice(at, at + t.length)) + '</b>' + esc(l.slice(at + t.length)) : esc(l);
      return `<div class="si" data-i="${i}"><span class="sl">${lab}</span><span class="sn">${k.n}</span></div>`;
    }).join('');
    place();
  };
  const mark = () => { kwSug.el.querySelectorAll('.si').forEach((e, i) => e.classList.toggle('on', i === idx)); kwSug.el.querySelector('.si.on')?.scrollIntoView({ block: 'nearest' }); };
  const choose = i => { const k = items[i]; if (!k) return; closeKwSug(); pick(k.label); };
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(() => { if (kwSug && kwSug.input === input) closeKwSug(); }, 120));
  input.addEventListener('keydown', ev => {                          // 캡처 단계: 기존 Enter/Esc 처리보다 먼저 실행
    if (ev.isComposing) return;
    if ((!kwSug || kwSug.input !== input) && ev.key === 'ArrowDown') { ev.preventDefault(); render(); return; }   // 닫혀 있을 때 ↓ 키로 열기
    if (!kwSug || kwSug.input !== input) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault(); ev.stopImmediatePropagation();
      const n = items.length; idx = ev.key === 'ArrowDown' ? (idx + 1 >= n ? -1 : idx + 1) : (idx - 1 < -1 ? n - 1 : idx - 1);
      mark();
    } else if ((ev.key === 'Enter' || ev.key === 'Tab') && idx >= 0) {
      ev.preventDefault(); ev.stopImmediatePropagation(); choose(idx);
    } else if (ev.key === 'Escape') {
      ev.preventDefault(); ev.stopImmediatePropagation(); closeKwSug();
    }
  }, true);
  input.addEventListener('mousedown', () => { if (!kwSug) render(); });
  // 마우스로 고르기 (입력창이 포커스를 잃지 않게 mousedown에서 처리)
  document.addEventListener('mousedown', ev => {
    if (!kwSug || kwSug.input !== input) return;
    const it = ev.target.closest('.kwsug .si'); if (it) { ev.preventDefault(); choose(+it.dataset.i); }
  }, true);
}
window.addEventListener('resize', () => closeKwSug());

/* ---------- 키워드 추가·삭제 (엑셀의 키워드 칸에 저장) ---------- */
function startKwEdit(box, v, e) {
  if (S.editing) return toast('다른 수정이 진행 중입니다. 저장 또는 취소를 먼저 해 주세요.');
  S.editing = true;
  let list = e.keywords.slice();
  const draw = () => {
    box.innerHTML = list.map((k, i) => `<span class="kw kwed"${kwStyle(k)}>${esc(k)}<button class="kwx" data-i="${i}" title="삭제">×</button></span>`).join('') +
      `<input class="kwin" placeholder="키워드 입력 후 Enter (쉼표로 여러 개)" autocomplete="off">` +
      `<button class="btn sm" data-c>취소</button><button class="btn pri sm" data-s>엑셀에 저장</button><span class="edmsg"></span>`;
    box.querySelectorAll('.kwx').forEach(b => b.onclick = ev => { ev.stopPropagation(); list.splice(+b.dataset.i, 1); draw(); box.querySelector('.kwin').focus(); });
    const inp = box.querySelector('.kwin'), msg = box.querySelector('.edmsg'), save = box.querySelector('[data-s]');
    const add = () => {
      for (const k of inp.value.split(/[,，]/).map(x => x.trim()).filter(Boolean))
        if (!list.some(x => x.toLowerCase() === k.toLowerCase())) list.push(k);
      inp.value = '';
    };
    const end = () => { closeKwSug(); S.editing = false; updateAll(); };
    box.querySelector('[data-c]').onclick = end;
    save.onclick = async () => {
      add();
      save.disabled = true; msg.textContent = '저장 중…';
      try {
        await api('/api/entry/keywords', { file: v.wb, sheet: v.sheet, row: e.row, keywords: list, expected: e.keywords });
        S.editing = false; toast('키워드를 엑셀에 저장했습니다.');
        await loadAll(true);
      } catch (err) { msg.textContent = err.message; save.disabled = false; }
    };
    attachKwSuggest(inp, {
      getTaken: () => list.slice(), lastToken: () => inp.value.split(/[,，]/).at(-1),
      pick: label => { const pre = inp.value.split(/[,，]/).slice(0, -1); inp.value = [...pre, label].join(','); add(); draw(); box.querySelector('.kwin').focus(); },
    });
    inp.onkeydown = ev => {
      if (ev.isComposing) return;
      if (ev.key === 'Enter') { ev.preventDefault(); if (inp.value.trim()) { add(); draw(); box.querySelector('.kwin').focus(); } else save.click(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); end(); }
      else if (ev.key === 'Backspace' && !inp.value && list.length) { list.pop(); draw(); box.querySelector('.kwin').focus(); }
    };
    inp.focus();
  };
  draw();
}

/* ---------- 키워드 버튼 → 미리보기 팝업 ---------- */
let kwPop = null, kwKey = null;
function closeKwPop() {
  if (kwPop) { const d = kwPop; kwPop = null; if (d.open) d.close(); d.remove(); }
}
const SWATCHES = ['#fde2e2', '#fde8c8', '#fff3b0', '#d6f2d9', '#cdeefc', '#d9dcff', '#f0d9ff', '#d5dbe3'];
const HEX6 = /^#[0-9a-f]{6}$/i;
const KP_PAGE = 20;
function openKwPop(kw, anchor, origin) {
  closeKwPop();
  const nk = normKw(kw), vId = origin.vk, eId = origin.ek;
  const all = S.kwIndex.get(nk) || [];
  const items = all.filter(x => !(x.v.key === vId && x.e.key === eId));
  const nVideos = new Set(items.map(x => x.v.key)).size;
  const kst = { mode: S.sortDesc ? 'new' : 'old', q: '', page: 0 };
  kwKey = nk;
  const el = document.createElement('dialog'); el.className = 'kwpop';
  const cur = kwColor(kw) || '';
  el.innerHTML = `<div class="kph">
      <div class="l1"><span class="kwhead">${kwChip(kw, false)}</span><span class="cnt">${origin.vk ? '다른 ' : ''}타임스탬프 ${items.length}곳 · 영상 ${nVideos}개</span><button class="x" title="닫기 (Esc)">✕</button></div>
      <div class="l2"><span class="lb">버튼 색</span>${SWATCHES.map(c => `<button class="sw" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}
        <input type="color" id="kwPick" value="${cur || '#eef2fa'}" title="직접 고르기">
        <input type="text" id="kwHex" class="hex" maxlength="7" spellcheck="false" placeholder="#RRGGBB" value="${cur}" title="헥스코드를 직접 입력할 수 있습니다 (예: #ffd966)">
        <button class="btn sm" id="kwReset">기본색</button></div></div>
    <div class="kpt">
      <select id="kpSort" title="정렬"><option value="old">업로드 날짜 ↑ 오래된 순</option><option value="new">업로드 날짜 ↓ 최신 순</option></select>
      <input id="kpQ" type="search" placeholder="이 목록 안에서 검색 (예: (가 OR 나) & '두 단어')" autocomplete="off" spellcheck="false">
      <span class="kpc" id="kpCount"></span>
      <div class="kpp" id="kpParse" hidden></div>
    </div>
    <div class="kpb"></div>
    <div class="kpf"><button type="button" class="btn sm" data-p="first" title="처음">«</button><button type="button" class="btn sm" data-p="prev" title="이전 (←)">‹ 이전</button><span class="kpn" id="kpPage"></span><button type="button" class="btn sm" data-p="next" title="다음 (→)">다음 ›</button><button type="button" class="btn sm" data-p="last" title="끝">»</button></div>`;
  const body = el.querySelector('.kpb');
  el.querySelector('#kpSort').value = kst.mode;
  const snip = (t, terms) => {
    const s = t.replace(/\s+/g, ' ').trim(); if (!s) return '(메모 없음)';
    let start = 0;
    if (terms.length) { const lo = norm(s).toLowerCase(); const hit = terms.map(x => lo.indexOf(x)).filter(n => n >= 0).sort((a, b) => a - b)[0]; if (hit > 110) start = hit - 60; }
    const out = (start ? '…' : '') + s.slice(start, start + 160) + (s.length > start + 160 ? '…' : '');
    if (!terms.length) return esc(out);
    const re = new RegExp('(' + terms.map(reEsc).join('|') + ')', 'gi');
    return norm(out).split(re).map((p, i) => i % 2 ? `<mark>${esc(p)}</mark>` : esc(p)).join('');
  };
  const view = () => {
    const pq = kst.q.trim() ? parseQuery(kst.q) : { node: null, terms: [] };
    let list = items;
    if (pq.node) list = list.filter(x => evalNode(pq.node, norm(`${x.e.text} ${x.e.keywords.join(' ')} ${x.v.title}`).toLowerCase()));
    const sk = x => x.e.bad ? 1e12 : x.e.sec, dir = kst.mode === 'new' ? -1 : 1;
    const dc = (a, b) => !a.date && !b.date ? 0 : !a.date ? 1 : !b.date ? -1 : (a.date < b.date ? -dir : a.date > b.date ? dir : 0);
    list = list.slice().sort((a, b) => dc(a.v, b.v) || cmp(a.v.key, b.v.key) || sk(a) - sk(b) || a.e.row - b.e.row);
    return { list, pq };
  };
  const render = (keepScroll) => {
    const { list, pq } = view();
    const pages = Math.max(1, Math.ceil(list.length / KP_PAGE));
    kst.page = Math.min(Math.max(0, kst.page), pages - 1);
    const slice = list.slice(kst.page * KP_PAGE, (kst.page + 1) * KP_PAGE);
    let html = '', last = null;
    for (const x of slice) {
      if (x.v.key !== last) {
        last = x.v.key;
        html += `<div class="kg">${esc(x.v.title)}${x.v.dateText ? ' · ' + esc(x.v.dateText) : ''}${x.v.key === vId ? ' (현재 영상)' : ''}</div>`;
      }
      html += `<div class="ki" data-v="${esc(x.v.key)}" data-e="${esc(x.e.key)}">${bmFind(x.v.key, x.e.key) ? '<span class="bk" title="즐겨찾기">★</span>' : ''}<span class="t">${x.e.bad ? '?' : fmt(x.e.sec)}</span><span class="sn">${snip(x.e.text, pq.terms)}</span></div>`;
    }
    let top = '';
    const bms = kst.page === 0 ? list.filter(x => bmFind(x.v.key, x.e.key)) : [];
    if (bms.length) top = `<div class="kg bmk">★ 즐겨찾기 ${bms.length}곳</div>` + bms.slice(0, 10).map(x => { const b = bmFind(x.v.key, x.e.key); return `<div class="ki bmki" data-v="${esc(x.v.key)}" data-e="${esc(x.e.key)}"><span class="bk">★</span><span class="t">${x.e.bad ? '?' : fmt(x.e.sec)}</span><span class="sn"><b>${esc(b.name)}</b> · ${esc(x.v.title)}</span></div>`; }).join('') + (bms.length > 10 ? `<div class="hint" style="padding:2px 8px">…외 ${bms.length - 10}곳</div>` : '') + '<div class="kg bmk2">전체 목록</div>';
    body.innerHTML = top + (html || `<div class="kpe">${items.length ? '검색 조건에 맞는 항목이 없습니다.' : '이 키워드가 적힌 다른 타임스탬프가 없습니다.'}</div>`);
    if (!keepScroll) body.scrollTop = 0;
    const pe = el.querySelector('#kpParse'), cx = pq.node && pq.node.op !== 'term';
    pe.hidden = !cx && !pq.warn;
    pe.innerHTML = (cx ? `<span class="pi">해석: <code>${esc(exprText(pq.node))}</code></span>` : '') + (pq.warn ? `<span class="pw">⚠ ${esc(pq.warn)}</span>` : '');
    el.querySelector('#kpCount').textContent = kst.q.trim() ? `${items.length}곳 중 ${list.length}곳` : '';
    el.querySelector('#kpPage').textContent = list.length ? `${kst.page + 1} / ${pages}쪽 · ${list.length}곳` : '0곳';
    const f = el.querySelector('.kpf'); f.hidden = pages <= 1;
    f.querySelectorAll('button').forEach(b => { const p = b.dataset.p; b.disabled = (p === 'first' || p === 'prev') ? kst.page === 0 : kst.page === pages - 1; });
    el._pages = pages;
  };
  el.querySelector('#kpSort').onchange = ev => { kst.mode = ev.target.value; kst.page = 0; render(); };
  el.querySelector('#kpQ').oninput = ev => { kst.q = ev.target.value; kst.page = 0; render(); };
  el.querySelector('.kpf').onclick = ev => {
    const b = ev.target.closest('button'); if (!b || b.disabled) return;
    const p = b.dataset.p;
    kst.page = p === 'first' ? 0 : p === 'prev' ? kst.page - 1 : p === 'next' ? kst.page + 1 : (el._pages || 1) - 1;
    render();
  };
  el.addEventListener('keydown', ev => {
    if (ev.target.closest('input,select,textarea') || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key === 'ArrowRight') { kst.page++; render(); ev.preventDefault(); }
    else if (ev.key === 'ArrowLeft') { kst.page--; render(); ev.preventDefault(); }
  });
  document.body.appendChild(el); kwPop = el;
  el.showModal();
  render();

  const pick = el.querySelector('#kwPick'), hex = el.querySelector('#kwHex');
  const applyColor = c => {
    (S.refs.keywordColors ??= {});
    if (c) S.refs.keywordColors[nk] = c; else delete S.refs.keywordColors[nk];
    el.querySelector('.kwhead').innerHTML = kwChip(kw, false);
    renderKwBrowse(); updateAll();
  };
  const commit = async () => { await persist(); updateAll(); };
  const setBoth = c => { pick.value = c || '#eef2fa'; hex.value = c || ''; hex.classList.remove('bad'); };
  el.querySelector('.x').onclick = closeKwPop;
  el.querySelectorAll('.sw').forEach(b => b.onclick = async () => { setBoth(b.dataset.c); applyColor(b.dataset.c); await commit(); });
  pick.oninput = ev => { hex.value = ev.target.value; hex.classList.remove('bad'); applyColor(ev.target.value); };
  pick.onchange = commit;
  hex.oninput = () => {
    let v = hex.value.trim(); if (v && v[0] !== '#') v = '#' + v;
    if (HEX6.test(v)) { v = v.toLowerCase(); if (hex.value !== v) hex.value = v; hex.classList.remove('bad'); pick.value = v; applyColor(v); }
    else hex.classList.toggle('bad', v.length > 0);
  };
  hex.onchange = async () => { if (!hex.classList.contains('bad')) await commit(); };
  hex.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); hex.blur(); } };
  el.querySelector('#kwReset').onclick = async () => { applyColor(''); setBoth(''); await commit(); };
  body.onclick = ev => {
    const it = ev.target.closest('.ki'); if (!it) return;
    closeKwPop(); openVideo(it.dataset.v, it.dataset.e);
    scrollSel();
  };
  // 어두운 배경(창 바깥)을 누르면 닫기
  el.addEventListener('mousedown', ev => { if (ev.target === el) closeKwPop(); });
  el.addEventListener('close', () => { if (kwPop === el) closeKwPop(); });
}

/* ---------- 참고자료 ---------- */
async function addRefs() {
  const v = curVideo(), e = curEntry();
  if (!v || !e || e.bad) return;
  let files;
  try {
    const r = await api('/api/pick-file', {});
    if (r.error) {
      const p = await ask({ title: '파일 경로 입력', msg: '파일 선택창을 열 수 없습니다. 파일 경로를 붙여넣어 주세요.\n(탐색기에서 파일을 Shift+우클릭 → "경로로 복사")', value: '' });
      if (!p) return;
      files = [await api('/api/normalize', { path: p })];
    } else files = r.files;
  } catch (err) { return toast(err.message); }
  if (!files.length) return;
  const vr = (S.refs.videos[v.key] ??= {});
  const list = ((vr.refs ??= {})[e.key] ??= []);
  for (const f of files) {
    const label = await ask({ title: '참고자료 이름', msg: f.path, value: f.name });
    if (label === null) continue;
    list.push({ label, path: f.path });
  }
  await persist(); computeHits(); renderSide(); updateAll();
}
async function renameRef(i) {
  const v = curVideo(), e = curEntry(), r = entryRefs(v, e)[i]; if (!r) return;
  const label = await ask({ title: '참고자료 이름 변경', msg: r.path, value: r.label });
  if (label === null) return;
  r.label = label; await persist(); computeHits(); renderSide(); updateAll();
}
async function delRef(i) {
  const v = curVideo(), e = curEntry(), r = entryRefs(v, e)[i]; if (!r) return;
  if (!await ask({ title: '연결 해제', msg: `"${r.label}" 연결을 해제할까요?\n(컴퓨터의 원본 파일은 삭제되지 않습니다)`, ok: '해제' })) return;
  S.refs.videos[v.key].refs[e.key].splice(i, 1);
  await persist(); computeHits(); renderSide(); updateAll();
}

const TEXT_EXT = /\.(txt|md|csv|tsv|json|log|xml|html?|ini|ya?ml|py|js|css|srt|vtt)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
let viewerCtx = null;
async function openViewer(i) {
  const v = curVideo(), e = curEntry(), r = entryRefs(v, e)[i]; if (!r) return;
  viewerCtx = { v, e, i, r };
  const body = $('#vwb');
  $('#vwt').textContent = r.label; $('#vwp').textContent = r.path;
  body.innerHTML = '<div class="hint">불러오는 중…</div>';
  $('#vwOpen').style.display = $('#vwReveal').style.display = '';
  $('#viewer').showModal();
  const url = '/api/file?p=' + encodeURIComponent(r.path);
  if (r.missing) return showMissing();
  try {
    if (IMG_EXT.test(r.path)) body.innerHTML = `<img src="${url}" alt="">`;
    else if (/\.pdf$/i.test(r.path)) body.innerHTML = `<iframe src="${url}"></iframe>`;
    else if (TEXT_EXT.test(r.path)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
      const buf = await res.arrayBuffer();
      let txt; try { txt = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { txt = new TextDecoder('euc-kr').decode(buf); }
      body.innerHTML = `<pre>${esc(txt.length > 300000 ? txt.slice(0, 300000) + '\n\n… (이후 생략, 전체는 "기본 프로그램으로 열기")' : txt)}</pre>`;
    } else body.innerHTML = '<div class="hint">이 형식은 미리보기를 지원하지 않습니다. 위의 [기본 프로그램으로 열기]를 눌러 주세요.</div>';
  } catch (err) { body.innerHTML = `<div class="warn">열 수 없습니다: ${esc(err.message)}</div>`; }
}
function showMissing() {
  $('#vwOpen').style.display = $('#vwReveal').style.display = 'none';
  $('#vwb').innerHTML = `<p class="warn">연결된 파일을 찾을 수 없습니다. 파일이 이동·삭제되었을 수 있습니다.</p>
    <button class="btn pri" id="relink">다른 파일로 다시 연결</button>`;
  $('#relink').onclick = async () => {
    try {
      const r = await api('/api/pick-file', {});
      if (r.error || !r.files?.length) return toast(r.error ? '파일 선택창을 열 수 없습니다.' : '선택하지 않았습니다.');
      viewerCtx.r.path = r.files[0].path;
      await persist(); $('#viewer').close(); updateAll();
    } catch (err) { toast(err.message); }
  };
}
$('#vwClose').onclick = () => $('#viewer').close();
$('#vwOpen').onclick = () => viewerCtx && api('/api/open', { p: viewerCtx.r.path }).catch(err => toast(err.message));
$('#vwReveal').onclick = () => viewerCtx && api('/api/open', { p: viewerCtx.r.path, reveal: true }).catch(err => toast(err.message));
$('#viewer').addEventListener('close', () => { if (!$('#viewer').open) $('#vwb').innerHTML = ''; });

/* ---------- 즐겨찾기 (폴더 계층, timeline-refs.json 의 bookmarks) ---------- */
const BM = () => (S.refs.bookmarks ??= { folders: [], items: [] });
const bmNewId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const bmFind = (vk, ek) => BM().items.find(b => b.v === vk && b.e === ek);
const bmFolder = id => BM().folders.find(f => f.id === id);
function bmPath(id) { const out = []; let f = bmFolder(id), n = 0; while (f && n++ < 60) { out.unshift(f.name); f = bmFolder(f.parent); } return out; }
const bmPathText = id => ['즐겨찾기', ...bmPath(id)].join(' › ');
const bmKids = parent => BM().folders.filter(f => (f.parent || '') === parent).sort((a, b) => cmp(a.name, b.name));
function bmDesc(id, out = new Set()) { out.add(id); for (const f of bmKids(id)) bmDesc(f.id, out); return out; }
const bmCountIn = id => BM().items.filter(b => b.folder === id).length;
const bmSnip = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
/* 즐겨찾기가 가리키는 영상·타임스탬프를 찾는다 (시간이 조금 바뀐 경우 5초 이내 가장 가까운 것) */
function bmTarget(b) {
  const v = S.videos.find(x => x.key === b.v);
  if (!v) return { v: null, e: null, exact: false };
  let e = v.entries.find(x => x.key === b.e && !x.bad) || null;
  if (!e && b.sec != null) {
    let best = null;
    for (const x of validEntries(v)) if (Math.abs(x.sec - b.sec) <= 5 && (!best || Math.abs(x.sec - b.sec) < Math.abs(best.sec - b.sec))) best = x;
    e = best;
  }
  return { v, e, exact: !!e && e.key === b.e };
}
const bmInfo = (v, e) => ({ vk: v.key, ek: e.key, sec: e.sec, title: v.title, text: e.text });
const bmCountText = () => { const n = BM().items.length; return n ? `(${n})` : ''; };

function refreshBmUi() {
  $('#bmCount').textContent = bmCountText();
  if (curVideo() && $('#list')) { updateBar(); updateList(); updateDetail(); }
  updateSummary(); renderSide();
  if ($('#bmmgr').open) bmMgrRender();
}
const bmCollapsed = new Set();
/* 폴더 트리 (추가창·관리창·폴더 선택창에서 같이 사용) */
function bmTree(host, o) {
  const draw = () => {
    const ex = o.exclude, rows = [{ id: '', name: o.root || '최상위', depth: 0, kids: 0 }];
    const walk = (parent, depth) => {
      for (const f of bmKids(parent)) {
        if (ex && ex.has(f.id)) continue;
        const kids = bmKids(f.id).filter(k => !(ex && ex.has(k.id))).length;
        rows.push({ id: f.id, name: f.name, depth, kids });
        if (!bmCollapsed.has(f.id)) walk(f.id, depth + 1);
      }
    };
    walk('', 1);
    host.innerHTML = rows.map(r => `<div class="bmf${r.id === o.sel ? ' on' : ''}" data-id="${esc(r.id)}" style="padding-left:${4 + r.depth * 16}px">
      <button type="button" class="bmt" data-t="${esc(r.id)}" tabindex="-1"${r.kids ? '' : ' disabled'}>${r.kids ? (bmCollapsed.has(r.id) ? '▸' : '▾') : ''}</button>
      <span class="bmn">${r.id ? '📁' : '⭐'} ${esc(r.name)}</span>${o.counts ? `<span class="bmc">${r.id ? bmCountIn(r.id) : BM().items.filter(b => !b.folder).length}</span>` : ''}</div>`).join('');
  };
  host.onclick = ev => {
    const t = ev.target.closest('.bmt');
    if (t) { if (t.dataset.t) { bmCollapsed.has(t.dataset.t) ? bmCollapsed.delete(t.dataset.t) : bmCollapsed.add(t.dataset.t); draw(); } return; }
    const r = ev.target.closest('.bmf'); if (!r) return;
    o.sel = r.dataset.id; draw(); o.onPick && o.onPick(o.sel);
  };
  o.redraw = draw; draw(); return o;
}
async function bmNewFolder(parent) {
  const name = await ask({ title: '새 폴더', msg: '위치: ' + bmPathText(parent), value: '새 폴더', ok: '만들기' });
  if (!name) return null;
  const f = { id: bmNewId('f'), name: String(name).trim().slice(0, 100), parent };
  BM().folders.push(f); bmCollapsed.delete(parent); return f.id;
}
/* 폴더 고르기 창 (이동할 때) → 폴더 id('' = 최상위) 또는 null(취소) */
function bmPickFolder({ title, exclude = null, current = '' }) {
  return new Promise(res => {
    const d = $('#bmpick');
    d.innerHTML = `<div class="bmbox"><div class="bmh1"><b>${esc(title)}</b><button class="x" data-x title="닫기">✕</button></div>
      <div class="bmtree" id="bmpTree"></div>
      <div class="bmbtns"><button class="btn sm" id="bmpNew">＋ 새 폴더</button><span class="sp"></span><button class="btn" data-x>취소</button><button class="btn pri" id="bmpOk">여기로 이동</button></div></div>`;
    const st = { sel: current, exclude, root: '즐겨찾기 (최상위)' };
    bmTree(d.querySelector('#bmpTree'), st);
    let done = false;
    const fin = v => { if (done) return; done = true; if (d.open) d.close(); res(v); };
    d.querySelectorAll('[data-x]').forEach(b => b.onclick = () => fin(null));
    d.querySelector('#bmpOk').onclick = () => fin(st.sel);
    d.querySelector('#bmpNew').onclick = async () => { const id = await bmNewFolder(st.sel); if (id != null) { st.sel = id; st.redraw(); } };
    d.oncancel = ev => { ev.preventDefault(); fin(null); };
    d.showModal();
  });
}
/* 별 버튼: 추가/편집 창 */
function bmOpen(info, existing) {
  const b = existing || bmFind(info.vk, info.ek);
  const d = $('#bmdlg'), defName = bmSnip(info.text, 40) || fmt(info.sec || 0);
  const st = { sel: b ? b.folder : (S.bmLast || ''), root: '즐겨찾기 (최상위)' };
  if (st.sel && !bmFolder(st.sel)) st.sel = '';
  d.innerHTML = `<div class="bmbox"><div class="bmh1"><b>${b ? '★ 즐겨찾기 편집' : '☆ 즐겨찾기 추가'}</b><button class="x" data-x title="닫기 (Esc)">✕</button></div>
    <div class="bmsub">${esc(info.title || '')} · <b>${info.sec != null ? fmt(info.sec) : '?'}</b></div>
    <label class="bml">이름<input id="bmName" maxlength="200" autocomplete="off" value="${esc(b ? b.name : defName)}"></label>
    <label class="bml">메모 (선택)<textarea id="bmNote" rows="2" maxlength="1000">${esc(b ? b.note : '')}</textarea></label>
    <div class="bmlab"><span>저장 위치: <b id="bmWhere"></b></span><button class="btn sm" id="bmNew" type="button">＋ 새 폴더</button></div>
    <div class="bmtree" id="bmTreeHost"></div>
    <div class="bmbtns">${b ? '<button class="btn danger" id="bmDel" type="button">즐겨찾기 삭제</button>' : ''}<span class="sp"></span><button class="btn" data-x type="button">취소</button><button class="btn pri" id="bmSave" type="button">저장</button></div></div>`;
  const where = () => { d.querySelector('#bmWhere').textContent = bmPathText(st.sel); };
  st.onPick = where; bmTree(d.querySelector('#bmTreeHost'), st); where();
  d.querySelectorAll('[data-x]').forEach(x => x.onclick = () => d.close());
  d.querySelector('#bmNew').onclick = async () => { const id = await bmNewFolder(st.sel); if (id != null) { st.sel = id; st.redraw(); where(); } };
  const save = async () => {
    const name = d.querySelector('#bmName').value.trim() || defName, note = d.querySelector('#bmNote').value.trim();
    if (b) { b.name = name; b.note = note; b.folder = st.sel; }
    else BM().items.push({ id: bmNewId('b'), v: info.vk, e: info.ek, sec: info.sec ?? null, title: String(info.title || '').slice(0, 200), name, note, folder: st.sel, ts: Date.now() });
    S.bmLast = st.sel;
    d.close(); await persist(); refreshBmUi(); toast(b ? '즐겨찾기를 수정했습니다.' : '즐겨찾기에 추가했습니다.');
  };
  d.querySelector('#bmSave').onclick = save;
  const del = d.querySelector('#bmDel');
  if (del) del.onclick = async () => {
    if (!await ask({ title: '즐겨찾기 삭제', msg: `'${b.name}' 을(를) 삭제할까요?`, ok: '삭제' })) return;
    BM().items = BM().items.filter(x => x !== b);
    d.close(); await persist(); refreshBmUi(); toast('삭제했습니다.');
  };
  d.querySelector('#bmName').onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } };
  d.showModal(); d.querySelector('#bmName').select();
}
function bmGo(b) {
  const t = bmTarget(b);
  if (!t.v) return toast('이 영상을 찾을 수 없습니다. (엑셀에서 지웠거나 이름이 바뀌었을 수 있습니다)', 5000);
  if ($('#bmmgr').open) $('#bmmgr').close();
  closeKwPop();
  openVideo(t.v.key, t.e ? t.e.key : undefined); scrollSel();
  if (!t.e) toast('같은 시간의 타임스탬프를 찾지 못해 영상만 열었습니다.', 5000);
  else if (!t.exact) toast('시간이 바뀐 것 같아 가장 가까운 타임스탬프로 이동했습니다.', 5000);
}
const bmMeta = b => { const t = bmTarget(b); return `${esc(t.v ? t.v.title : (b.title || '(영상 없음)'))} · ${b.sec != null ? fmt(b.sec) : '?'}${t.v ? '' : ' ⚠ 영상을 찾을 수 없음'}`; };
/* 관리창 */
const mg = { sel: '', q: '' };
function bmMgrMatches(q) {
  const pq = parseQuery(q); if (!pq.node) return null;
  return BM().items.filter(b => {
    const t = bmTarget(b), base = t.v && t.e ? [t.e.text, t.e.keywords.join(' ')].join(' ') : '';
    return evalNode(pq.node, norm(`${b.name} ${b.note} ${bmPath(b.folder).join(' ')} ${t.v ? t.v.title : b.title} ${base}`).toLowerCase());
  });
}
function bmMgrRender() {
  const d = $('#bmmgr'); if (!d.open) return;
  if (mg.sel && !bmFolder(mg.sel)) mg.sel = '';
  const searching = !!mg.q.trim(), res = searching ? bmMgrMatches(mg.q) : null;
  const items = searching ? (res || []) : BM().items.filter(b => b.folder === mg.sel);
  const tree = bmTree(d.querySelector('#bmgTree'), { sel: mg.sel, counts: true, root: '즐겨찾기 (최상위)', onPick: id => { mg.sel = id; mg.q = ''; d.querySelector('#bmgQ').value = ''; bmMgrRender(); } });
  d.querySelector('#bmgHead').textContent = searching ? `검색 결과 ${items.length}개 (모든 폴더)` : `${bmPathText(mg.sel)} · ${items.length}개`;
  const fb = d.querySelectorAll('[data-fa]'); fb.forEach(b => { if (b.dataset.fa !== 'new') b.disabled = !mg.sel; });
  d.querySelector('#bmgList').innerHTML = items.length ? items.map(b => {
    const t = bmTarget(b);
    return `<div class="bmr${t.v ? '' : ' miss'}" data-id="${esc(b.id)}"><div class="bmrm">
      <div class="bn">★ ${esc(b.name || '(이름 없음)')}</div>
      <div class="bp">${searching ? '📁 ' + esc(bmPathText(b.folder)) + ' · ' : ''}${bmMeta(b)}</div>
      ${b.note ? `<div class="bnote">${esc(bmSnip(b.note, 120))}</div>` : ''}</div>
      <div class="bmra"><button class="btn sm" data-a="edit" title="이름·메모·위치 수정">✎</button><button class="btn sm" data-a="move" title="다른 폴더로 이동">📂</button><button class="btn sm" data-a="del" title="삭제">🗑</button></div></div>`;
  }).join('') : `<div class="hint" style="padding:14px">${searching ? '일치하는 즐겨찾기가 없습니다.' : '이 폴더에 즐겨찾기가 없습니다. 타임라인 목록의 ☆ 버튼으로 추가하세요.'}</div>`;
  const p = d.querySelector('#bmgParse'), pq = searching ? parseQuery(mg.q) : null;
  const cx = pq && pq.node && pq.node.op !== 'term'; p.hidden = !cx && !(pq && pq.warn);
  p.innerHTML = (cx ? `해석: <code>${esc(exprText(pq.node))}</code> ` : '') + (pq && pq.warn ? `<span class="pw">⚠ ${esc(pq.warn)}</span>` : '');
}
function openBmMgr() {
  const d = $('#bmmgr');
  d.innerHTML = `<div class="bmmbox"><div class="bmh1"><b>★ 즐겨찾기 관리</b><input id="bmgQ" type="search" placeholder="모든 즐겨찾기에서 검색 (예: (가 OR 나) & 다)" autocomplete="off" spellcheck="false"><button class="x" data-x title="닫기 (Esc)">✕</button></div>
    <div class="bmgp" id="bmgParse" hidden></div>
    <div class="bmbody"><div class="bmleft"><div class="bmfb">
        <button class="btn sm" data-fa="new" title="선택한 폴더 안에 새 폴더">＋ 폴더</button><button class="btn sm" data-fa="ren" title="폴더 이름 바꾸기">✎ 이름</button><button class="btn sm" data-fa="move" title="폴더를 다른 폴더 안으로 이동">📂 이동</button><button class="btn sm" data-fa="del" title="폴더와 안의 즐겨찾기 삭제">🗑 삭제</button></div>
      <div class="bmtree big" id="bmgTree"></div></div>
      <div class="bmright"><div class="bmgh" id="bmgHead"></div><div id="bmgList"></div></div></div></div>`;
  d.querySelector('[data-x]').onclick = () => d.close();
  d.querySelector('#bmgQ').oninput = ev => { mg.q = ev.target.value; bmMgrRender(); };
  d.querySelector('.bmfb').onclick = async ev => {
    const b = ev.target.closest('[data-fa]'); if (!b || b.disabled) return;
    const a = b.dataset.fa, f = bmFolder(mg.sel);
    if (a === 'new') { const id = await bmNewFolder(mg.sel); if (id != null) { mg.sel = id; mg.q = ''; await persist(); } }
    else if (a === 'ren' && f) { const n = await ask({ title: '폴더 이름 바꾸기', msg: bmPathText(f.id), value: f.name }); if (n) { f.name = String(n).trim().slice(0, 100); await persist(); } }
    else if (a === 'move' && f) { const to = await bmPickFolder({ title: `'${f.name}' 폴더를 옮길 위치`, exclude: bmDesc(f.id), current: f.parent }); if (to != null) { f.parent = to; await persist(); } }
    else if (a === 'del' && f) {
      const ids = bmDesc(f.id), n = BM().items.filter(x => ids.has(x.folder)).length;
      if (!await ask({ title: '폴더 삭제', msg: `'${f.name}' 폴더와 하위 폴더 ${ids.size - 1}개, 즐겨찾기 ${n}개를 모두 삭제합니다.`, ok: '삭제' })) return;
      BM().folders = BM().folders.filter(x => !ids.has(x.id)); BM().items = BM().items.filter(x => !ids.has(x.folder));
      mg.sel = f.parent || ''; await persist();
    }
    refreshBmUi();
  };
  d.querySelector('#bmgList').onclick = async ev => {
    const row = ev.target.closest('.bmr'); if (!row) return;
    const b = BM().items.find(x => x.id === row.dataset.id); if (!b) return;
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (!a) return bmGo(b);
    if (a === 'edit') { const t = bmTarget(b); return bmOpen({ vk: b.v, ek: b.e, sec: b.sec, title: t.v ? t.v.title : b.title, text: t.e ? t.e.text : '' }, b); }
    if (a === 'move') { const to = await bmPickFolder({ title: `'${b.name}' 을(를) 옮길 폴더`, current: b.folder }); if (to != null) { b.folder = to; await persist(); refreshBmUi(); } return; }
    if (a === 'del') { if (!await ask({ title: '즐겨찾기 삭제', msg: `'${b.name}' 을(를) 삭제할까요?`, ok: '삭제' })) return; BM().items = BM().items.filter(x => x !== b); await persist(); refreshBmUi(); }
  };
  d.onmousedown = ev => { if (ev.target === d) d.close(); };
  d.showModal(); bmMgrRender(); d.querySelector('#bmgQ').value = mg.q;
}
/* 검색할 때 사이드바 위쪽에 따로 보여 줄 즐겨찾기 */
function bmMatches() {
  const pq = parsed(); if (!pq.node || !BM().items.length) return [];
  return BM().items.filter(b => {
    const t = bmTarget(b), base = t.v && t.e ? hayOf(t.v, t.e) : '';
    return evalNode(pq.node, norm(`${base} ${b.name} ${b.note} ${bmPath(b.folder).join(' ')} ${t.v ? t.v.title : b.title}`).toLowerCase());
  });
}
function bmSection() {
  const ms = bmMatches(); if (!ms.length) return '';
  const rows = ms.slice(0, 40).map(b => `<div class="bmi${bmTarget(b).v ? '' : ' miss'}" data-id="${esc(b.id)}" title="${esc(bmPathText(b.folder))}"><span class="bs">★</span><div class="bmim"><div class="bn">${esc(b.name || '(이름 없음)')}</div><div class="bp">📁 ${esc(bmPath(b.folder).join(' › ') || '최상위')} · ${bmMeta(b)}</div></div></div>`).join('');
  return `<div class="bsh">★ 즐겨찾기 ${ms.length}개</div>${rows}${ms.length > 40 ? `<div class="hint" style="padding:4px 8px">…외 ${ms.length - 40}개 (관리창에서 검색)</div>` : ''}<div class="bsh">🎞 영상</div>`;
}

/* ---------- 영상(시트) 메뉴: 이름 변경 · 위치 이동 · 삭제 ---------- */
let vmenuEl = null;
function closeVMenu() {
  if (!vmenuEl) return;
  document.querySelectorAll('.vmore.open').forEach(b => b.classList.remove('open'));
  vmenuEl.remove(); vmenuEl = null;
}
function openVMenu(btn) {
  const same = vmenuEl && vmenuEl.dataset.k === btn.dataset.vm;
  closeVMenu(); if (same) return;
  const v = S.videos.find(x => x.key === btn.dataset.vm); if (!v) return;
  const el = document.createElement('div');
  el.className = 'vmenu'; el.dataset.k = v.key; el.setAttribute('role', 'menu');
  el.innerHTML = `<button type="button" role="menuitem" data-a="rename">✎ 이름 변경</button><button type="button" role="menuitem" data-a="move">📂 위치 이동</button><button type="button" role="menuitem" class="danger" data-a="del">🗑 삭제</button>`;
  document.body.appendChild(el);
  const r = btn.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(6, Math.min(r.right - w, innerWidth - w - 6)) + 'px';
  el.style.top = (r.bottom + 4 + h > innerHeight && r.top - h - 4 > 0 ? r.top - h - 4 : r.bottom + 4) + 'px';
  btn.classList.add('open');
  el.onclick = ev => {
    const b = ev.target.closest('button[data-a]'); if (!b) return;
    closeVMenu(); ({ rename: vmRename, move: vmMove, del: vmDelete })[b.dataset.a](v);
  };
  el.onkeydown = ev => {
    const bs = [...el.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeVMenu(); btn.focus(); }
    else if (ev.key === 'Tab') closeVMenu();
  };
  vmenuEl = el; el.querySelector('button').focus();
}
document.addEventListener('mousedown', ev => { if (vmenuEl && !ev.target.closest('.vmenu') && !ev.target.closest('[data-vm]')) closeVMenu(); }, true);
$('#side').addEventListener('scroll', closeVMenu);
window.addEventListener('resize', closeVMenu);

const vmBusy = () => { if (S.editing) { toast('다른 수정이 진행 중입니다. 저장 또는 취소를 먼저 해 주세요.'); return true; } return false; };
/* 작업 뒤 목록을 새로 읽고, 보고 있던 영상이면 새 이름의 영상을 다시 엽니다 */
async function vmAfter(v, newKey) {
  const wasSel = S.selKey === v.key, ent = S.selEntry;
  await loadAll();
  if (wasSel && newKey && S.videos.some(x => x.key === newKey)) openVideo(newKey, ent);
}

function vmRename(v) {
  if (vmBusy()) return;
  const d = $('#vmdlg');
  d.innerHTML = `<form method="dialog" class="bmform"><h3>✎ 영상 이름 변경</h3>
    <label>영상 제목 <span class="hint">화면에 보이는 이름 (엑셀 B1 칸)</span><input id="vrT" value="${esc(v.title)}" autocomplete="off" maxlength="300"></label>
    <label>시트 이름 <span class="hint">엑셀 아래쪽 탭 이름 · 31자까지, [ ] : * ? / \\ 는 쓸 수 없음</span><input id="vrN" value="${esc(v.sheet)}" autocomplete="off" maxlength="31"></label>
    <div class="hint">위치: ${esc(v.wb)}<br>이름을 바꿔도 연결한 참고자료·즐겨찾기·아이콘은 그대로 이어지고, 바꾸기 전에 엑셀 파일을 자동 백업합니다.</div>
    <div class="edbar"><span class="edmsg" id="vrM"></span><button class="btn sm" type="button" id="vrC">취소</button><button class="btn pri sm" type="button" id="vrS">이름 변경</button></div></form>`;
  d.showModal(); $('#vrT').select();
  $('#vrC').onclick = () => d.close();
  const go = async () => {
    const msg = $('#vrM'), btn = $('#vrS'), title = $('#vrT').value.trim(), name = $('#vrN').value.trim();
    if (!title) { msg.textContent = '영상 제목을 입력해 주세요'; return; }
    if (!name) { msg.textContent = '시트 이름을 입력해 주세요'; return; }
    if (title === v.title && name === v.sheet) { msg.textContent = '바뀐 내용이 없습니다'; return; }
    btn.disabled = true; msg.textContent = '저장 중…';
    try {
      const r = await api('/api/video/rename', { file: v.wb, sheet: v.sheet, name, title });
      d.close(); toast('이름을 바꿨습니다.'); await vmAfter(v, r.key);
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
  $('#vrS').onclick = go;
  d.onkeydown = ev => { if (ev.isComposing) return; if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); go(); } };
}

async function vmDelete(v) {
  if (vmBusy()) return;
  const n = v.entries.length, nb = BM().items.filter(b => b.v === v.key).length;
  const nr = Object.values(S.refs.videos[v.key]?.refs || {}).reduce((a, l) => a + l.length, 0);
  const extra = [nr ? `연결한 참고자료 ${nr}개` : '', nb ? `즐겨찾기 ${nb}개` : ''].filter(Boolean).join(', ');
  const yes = await ask({
    title: '영상 삭제', danger: true, ok: '삭제',
    msg: `'${v.title}'\n\n엑셀 문서 '${v.wb}'에서 시트 '${v.sheet}'를 삭제합니다.\n타임라인 ${n}개${extra ? ', ' + extra : ''}가 함께 사라집니다.\n\n삭제하기 전에 엑셀 파일을 자동 백업합니다 (library/.backup 폴더, 최근 10개).\n화면에서는 되돌릴 수 없습니다.`,
  });
  if (!yes) return;
  try {
    const r = await api('/api/video/delete', { file: v.wb, sheet: v.sheet });
    toast(`'${r.title || v.title}' 영상을 삭제했습니다.` + (r.refsWarning ? ' (연결 정보 정리는 종료할 때 마무리됩니다)' : ''), 5000);
    await vmAfter(v, null);
  } catch (err) { toast('삭제 실패: ' + err.message, 6000); }
}

/* 위치 이동: 옮길 엑셀 문서를 고르는 창 (즐겨찾기 폴더 이동창과 같은 방식) */
function vmMove(v) {
  if (vmBusy()) return;
  const d = $('#vmpick');
  const st = { sel: '', ctx: '', closed: new Set() };      // sel = 고른 엑셀 문서, ctx = 새 문서를 만들 폴더
  d.innerHTML = `<div class="bmbox"><div class="bmh1"><b>📂 '${esc(v.title)}' 을(를) 옮길 엑셀 문서</b><button class="x" data-x title="닫기">✕</button></div>
    <div class="bmsub">지금 위치: ${esc(v.wb)}</div>
    <div class="bmtree" id="vpTree"></div>
    <div class="hint">제목·주소·업로드일·재생 시간과 타임라인(시간·내용·키워드)이 새 시트로 옮겨지고, 연결한 참고자료·즐겨찾기·아이콘도 따라갑니다. 셀 서식과 그 밖의 칸은 옮겨지지 않습니다. 옮기기 전에 두 파일을 모두 자동 백업합니다.</div>
    <div class="bmbtns"><button class="btn sm" type="button" id="vpNew">＋ 새 엑셀 문서</button><span class="edmsg" id="vpM"></span><span class="sp"></span><button class="btn" type="button" data-x>취소</button><button class="btn pri" type="button" id="vpOk" disabled>여기로 이동</button></div></div>`;
  const tree = d.querySelector('#vpTree'), msg = d.querySelector('#vpM'), ok = d.querySelector('#vpOk');
  const draw = () => {
    const root = { f: {}, w: [] };
    for (const f of S.lib.files) {
      if (f.error) continue;
      const parts = f.path.split('/'); let n = root;
      for (const p of parts.slice(0, -1)) n = (n.f[p] ??= { f: {}, w: [] });
      n.w.push({ name: parts.at(-1), path: f.path, cnt: f.videos.length });
    }
    let h = `<div class="bmf${st.ctx === '' && !st.sel ? ' on' : ''}" data-dir="" style="padding-left:4px"><span class="bmn">⭐ 라이브러리 (최상위)</span></div>`;
    const walk = (n, prefix, depth) => {
      for (const name of Object.keys(n.f).sort(cmp)) {
        const p = prefix + name, open = !st.closed.has(p);
        h += `<div class="bmf${st.ctx === p && !st.sel ? ' on' : ''}" data-dir="${esc(p)}" style="padding-left:${4 + depth * 16}px"><button type="button" class="bmt" data-t="${esc(p)}" tabindex="-1">${open ? '▾' : '▸'}</button><span class="bmn">${esc(iconOf('dir', p))} ${esc(name)}</span></div>`;
        if (open) walk(n.f[name], p + '/', depth + 1);
      }
      for (const w of n.w.sort((a, b) => cmp(a.name, b.name))) {
        const cur = w.path === v.wb;
        h += `<div class="bmf${w.path === st.sel ? ' on' : ''}${cur ? ' dis' : ''}" data-file="${esc(w.path)}" style="padding-left:${4 + depth * 16 + 18}px" title="${cur ? '지금 이 영상이 있는 문서입니다' : esc(w.path)}"><span class="bmn">${esc(iconOf('file', w.path))} ${esc(w.name.replace(/\.xlsx$/i, ''))}</span><span class="bmc">${cur ? '현재 위치' : w.cnt + '개'}</span></div>`;
      }
    };
    walk(root, '', 1);
    tree.innerHTML = h;
    ok.disabled = !st.sel;
  };
  tree.onclick = ev => {
    const t = ev.target.closest('.bmt');
    if (t) { st.closed.has(t.dataset.t) ? st.closed.delete(t.dataset.t) : st.closed.add(t.dataset.t); draw(); return; }
    const f = ev.target.closest('[data-file]');
    if (f) { if (f.classList.contains('dis')) return; st.sel = f.dataset.file; st.ctx = st.sel.includes('/') ? st.sel.slice(0, st.sel.lastIndexOf('/')) : ''; msg.textContent = ''; draw(); return; }
    const dr = ev.target.closest('[data-dir]');
    if (dr) { st.ctx = dr.dataset.dir; st.sel = ''; draw(); }
  };
  let busy = false;
  const fin = () => { if (!busy && d.open) d.close(); };
  d.querySelectorAll('[data-x]').forEach(b => b.onclick = fin);
  d.oncancel = ev => { if (busy) ev.preventDefault(); };
  d.querySelector('#vpNew').onclick = async () => {
    const name = await ask({ title: '새 엑셀 문서', msg: '만들 위치: ' + (st.ctx || '라이브러리 (최상위)'), value: '새 문서', ok: '만들기' });
    if (!name) return;
    try {
      const r = await api('/api/doc/create', { folder: st.ctx, name });
      await loadAll(true); st.sel = r.path; msg.textContent = ''; draw();
    } catch (err) { msg.textContent = err.message; }
  };
  ok.onclick = async () => {
    if (!st.sel) return;
    busy = true; ok.disabled = true; msg.textContent = '옮기는 중… (타임라인이 많으면 시간이 걸립니다)';
    try {
      const r = await api('/api/video/move', { file: v.wb, sheet: v.sheet, dest: st.sel });
      busy = false; d.close();
      toast(`'${v.title}' 영상을 '${st.sel}'(으)로 옮겼습니다.` + (r.renamed ? ` 같은 이름의 시트가 있어 '${r.name}'(으)로 저장했습니다.` : '') + (r.refsWarning ? ' (연결 정보 정리는 종료할 때 마무리됩니다)' : ''), 7000);
      await vmAfter(v, r.key);
    } catch (err) { busy = false; msg.textContent = err.message; ok.disabled = !st.sel; }
  };
  draw(); d.showModal();
}

/* ---------- 상단 버튼 / 이벤트 ---------- */
$('#side').addEventListener('click', ev => {
  const vmb = ev.target.closest('[data-vm]');
  if (vmb) { ev.preventDefault(); ev.stopPropagation(); return openVMenu(vmb); }
  if (ev.target.closest('[data-import]')) { ev.preventDefault(); ev.stopPropagation(); return openImport(); }
  const nd = ev.target.closest('[data-newdoc]');
  if (nd) { ev.preventDefault(); ev.stopPropagation(); return openNewDoc(nd.dataset.newdoc); }
  const av = ev.target.closest('[data-addv]');
  if (av) { ev.preventDefault(); ev.stopPropagation(); return openAddVideo(av.dataset.addv); }
  const ico = ev.target.closest('.ico');
  if (ico) { ev.preventDefault(); ev.stopPropagation(); return openIconPicker(ico.dataset.ik, ico.dataset.ip); }  // 접기/펴기 대신 아이콘 변경
  const bi = ev.target.closest('.bmi');
  if (bi) { const b = BM().items.find(x => x.id === bi.dataset.id); return b && bmGo(b); }
  const el = ev.target.closest('.vi'); if (!el) return;
  openVideo(el.dataset.key);
});
/* 본문 클릭 처리: 키워드 → 팝업, ▸ → 펼침/접힘, ✎ → 수정, 행 → 선택 */
$('#main').addEventListener('click', ev => {
  const st = ev.target.closest('.row [data-star]');
  if (st) { const v = curVideo(), e = v && v.entries.find(x => x.key === st.closest('.row').dataset.k); return e && bmOpen(bmInfo(v, e)); }
  const kw = ev.target.closest('.kw');
  if (kw && kw.classList.contains('kwed')) return;      // 키워드 편집 중인 칩(×·칩 자체)은 팝업을 열지 않음
  if (kw) {
    const row = kw.closest('.row');
    return openKwPop(kw.dataset.kw, kw, { vk: S.selKey, ek: row ? row.dataset.k : S.selEntry });
  }
  const tg = ev.target.closest('[data-tg]');
  if (tg) {
    const v = curVideo(), k = tg.closest('.row').dataset.k, e = v.entries.find(x => x.key === k);
    S.toggle.set(v.key + '|' + k, !isOpen(v, e));
    return updateList();
  }
  const ed = ev.target.closest('[data-edit]');
  if (ed) {
    const v = curVideo(), row = ed.closest('.row');
    const e = row ? v.entries.find(x => x.key === row.dataset.k) : curEntry();
    const host = row ? row.querySelector('.rowbody') : $('#memoHost');
    return e && host && startEdit(host, v, e);
  }
  const row = ev.target.closest('.row');
  if (row && !row.classList.contains('bad') && !ev.target.closest('.rowbody')) selectEntry(row.dataset.k);
});
$('#btnSort').onclick = () => { S.sortDesc = !S.sortDesc; renderSide(); };
$('#btnMode').onclick = () => { S.mode = S.mode === 'tree' ? 'flat' : 'tree'; renderSide(); };
$('#btnRefresh').onclick = () => loadAll(true).then(() => toast('다시 읽었습니다.')).catch(err => toast(err.message));
$('#btnLib').onclick = async () => {
  try {
    const r = await api('/api/library/pick', {});
    let p;
    if (r.error) p = await ask({ title: '라이브러리 폴더 경로', msg: '엑셀 파일들이 들어 있는 폴더 경로를 입력해 주세요.', value: S.lib?.root || '' });
    else p = r.paths?.[0];
    if (!p) return;
    await api('/api/library/set', { path: p });
    S.selKey = null; S.selEntry = null;
    await loadAll(); toast('폴더를 변경했습니다.');
  } catch (err) { toast(err.message); }
};
$('#btnQuit').onclick = async () => {
  const nOrph = (S.orphans || []).length;
  if (!await ask({ title: '종료', msg: '서버를 종료할까요? 다시 쓰려면 run.bat 을 실행하세요.\n종료할 때 엑셀에 없는 항목의 흔적(끊어진 연결·없는 키워드 색 등)을 timeline-refs.json에서 정리하고, 걷어낸 내용은 timeline-refs.removed.json에 보관합니다.' + (nOrph ? `\n\n⚠ 아직 이어 붙이지 않은 끊어진 연결이 ${nOrph}곳 있습니다. 진단 › 연결 복구에서 이어 붙이지 않으면 이것도 보관 파일로 옮겨집니다.` : ''), ok: '종료' })) return;
  try { await api('/api/quit', {}); } catch { /* 무시 */ }
  document.body.innerHTML = '<div class="empty"><h2>종료되었습니다</h2><p>이 탭은 닫으셔도 됩니다. 다시 쓰려면 run.bat 을 실행하세요.</p></div>';
};

/* 이용 안내 (YouTube API Services 고지) */
function openInfo() {
  $('#infoVer').textContent = 'v' + WEB_VERSION;
  $('#info').showModal();
}
$('#btnInfo').onclick = openInfo;
$('#btnBm').onclick = openBmMgr;
$('#infoClose').onclick = () => $('#info').close();


/* ---------- 새 버전 알림 (알림만: 파일은 자동으로 바꾸지 않습니다) ---------- */
async function checkUpdate() {
  try {
    const u = await api('/api/update'); S.upd = u;
    const bar = $('#updbar'); if (!bar) return;
    let skip = ''; try { skip = localStorage.getItem('tlm-upd-skip') || ''; } catch { /* 무시 */ }
    if (!u.enabled || !u.newer || skip === u.latest) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `🆕 새 버전 <b>${esc(u.latest)}</b>이(가) 나왔습니다 (현재 v${esc(u.current)}). <a href="${esc(u.url)}" target="_blank" rel="noopener">받으러 가기 ↗</a>
      <span class="sp"></span><button class="btn sm" id="updLater" type="button">나중에</button><button class="btn sm" id="updSkip" type="button">이 버전은 건너뛰기</button>`;
    $('#updLater').onclick = () => { bar.hidden = true; };
    $('#updSkip').onclick = () => { try { localStorage.setItem('tlm-upd-skip', u.latest); } catch { /* 무시 */ } bar.hidden = true; };
  } catch { /* 네트워크가 없으면 조용히 넘어감 */ }
}

/* ---------- 다른 사람의 엑셀 불러오기(병합): 시간·내용·키워드만, 타임라인 단위로 골라서 ---------- */
const impNorm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
function impStatus(en, tv) {
  if (!tv) return 'new';
  const ents = tv.entries.filter(e => !e.bad && e.sec != null), n = impNorm(en.text), same = ents.filter(e => e.sec === en.sec);
  if (same.some(e => n ? impNorm(e.text) === n : (!impNorm(e.text) && impNorm((e.keywords || []).join()) === impNorm(en.keywords.join())))) return 'dup';
  if (n && ents.some(e => Math.abs(e.sec - en.sec) <= 3 && impNorm(e.text) === n)) return 'near';
  return same.length ? 'conf' : 'new';
}
const IMP_LB = { new: '새 항목', dup: '이미 있음', near: '비슷한 시간(±3초)·같은 내용', conf: '같은 시간·내용 다름 (별도 행 추가)' };

async function openImport() {
  if (S.editing) return toast('다른 수정이 진행 중입니다. 저장 또는 취소를 먼저 해 주세요.');
  let path;
  try {
    toast('엑셀 선택 창을 여는 중… (다른 창 뒤에 열렸다면 작업 표시줄을 확인해 주세요)', 2500);
    const r = await api('/api/import/pick', {});
    if (r.error === 'tk') {
      const v = await ask({ title: '불러올 엑셀 경로', msg: '파일 선택 창을 열 수 없습니다. 엑셀(.xlsx) 파일의 전체 경로를 붙여넣어 주세요.', value: '' });
      if (!v) return; path = v;
    } else path = (r.paths || [])[0];
  } catch (err) { return toast(err.message, 6000); }
  if (!path) return;
  let scan;
  try { scan = await api('/api/import/scan', { path }); } catch (err) { return toast(err.message, 7000); }
  const imp = { scan, si: 0, target: '', newWb: '', newName: '', checked: new Set(), noKw: false, busy: false, msg: '' };
  const d = $('#impdlg');
  const sh = () => imp.scan.sheets[imp.si];
  const matches = () => { const s = sh(); return s && s.vid ? S.videos.filter(v => ytId(v.url) === s.vid) : []; };
  const tv = () => imp.target && imp.target !== '__new' ? S.videos.find(v => v.key === imp.target) : null;
  const names = () => S.lib.files.filter(f => !f.error).map(f => f.path);
  const pickSheet = i => {                              // 시트를 바꾸면 대상·체크 상태를 다시 정함
    imp.si = i; const s = sh(); if (!s) return;
    const m = matches();
    imp.target = m.length ? m[0].key : '__new';
    imp.newWb = (m[0] && m[0].wb) || imp.newWb || names()[0] || '';
    imp.newName = String(s.title || s.sheet).replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
    resetChecks();
  };
  const resetChecks = () => {
    const s = sh(), t = tv(); imp.checked = new Set();
    if (s) s.entries.forEach((e, i) => { const st = impStatus(e, t); if (st === 'new' || st === 'conf') imp.checked.add(i); });
  };
  const render = () => {
    const keep = $('#impL') ? $('#impL').scrollTop : 0, s = sh(), t = tv(), m = matches();
    const head = `<div class="bmh1"><b>📥 다른 엑셀 불러오기 <span class="hint">— ${esc(imp.scan.file)}</span></b><button class="x" id="impX" title="닫기">✕</button></div>`;
    if (!s) {
      d.innerHTML = `<div class="bmmbox">${head}<div class="impbody"><p>이 파일에서 불러올 수 있는 영상 시트를 찾지 못했습니다.</p><div class="hint">영상 시트는 B1 제목 · B2 영상 주소 · 4행 머리글(타임라인 | 내용 | 키워드) 양식이어야 합니다.${imp.scan.skipped.length ? ` (제외된 시트: ${esc(imp.scan.skipped.join(', '))})` : ''}</div></div></div>`;
      return;
    }
    const sheetSel = imp.scan.sheets.length > 1 ? `<label class="impf">시트 <select id="impSheet">${imp.scan.sheets.map((x, i) => `<option value="${i}"${i === imp.si ? ' selected' : ''}>${esc(x.sheet)} — ${esc(x.title)} (${x.entries.length}개)</option>`).join('')}</select></label>` : `<div class="impf"><b>${esc(s.title)}</b> <span class="hint">· 타임라인 ${s.entries.length}개${s.bad ? ` · 시간 형식 오류 ${s.bad}개는 제외` : ''}</span></div>`;
    const tgt = `<label class="impf">넣을 곳 <select id="impTgt">${m.map(v => `<option value="${esc(v.key)}"${imp.target === v.key ? ' selected' : ''}>같은 영상: ${esc(v.wb.replace(/\.xlsx$/i, ''))} › ${esc(v.sheet)} (${v.entries.length}개)</option>`).join('')}<option value="__new"${imp.target === '__new' ? ' selected' : ''}>＋ 새 시트로 추가…</option></select></label>
      ${imp.target === '__new' ? `<div class="impf impnew"><label>문서 <select id="impWb">${names().map(n => `<option value="${esc(n)}"${n === imp.newWb ? ' selected' : ''}>${esc(n.replace(/\.xlsx$/i, ''))}</option>`).join('')}</select></label>
        <label>시트 이름 <input id="impNm" value="${esc(imp.newName)}" maxlength="31" autocomplete="off"></label></div>` : ''}
      ${m.length ? '' : `<div class="hint">${s.vid ? '내 라이브러리에는 이 영상과 같은 시트가 없습니다.' : '이 시트의 영상 주소를 유튜브 영상으로 인식하지 못했습니다.'} 새 시트로 만들거나, 위에서 다른 시트를 고르세요.</div>`}`;
    const rows = s.entries.map((e, i) => {
      const st = impStatus(e, t);
      return `<label class="improw st-${st}"><input type="checkbox" data-i="${i}"${imp.checked.has(i) ? ' checked' : ''}><span class="impt">${esc(e.time)}</span>
        <span class="impx">${esc(e.text) || '<i class="hint">(내용 없음)</i>'}</span>
        <span class="impk">${imp.noKw ? '' : e.keywords.map(k => `<span class="kw">${esc(k)}</span>`).join('')}</span><span class="imps">${IMP_LB[st]}</span></label>`;
    }).join('');
    const n = imp.checked.size;
    const dest = imp.target === '__new' ? `새 시트 '${esc(imp.newName || '?')}' (${esc(imp.newWb.replace(/\.xlsx$/i, ''))})` : (t ? `${esc(t.wb.replace(/\.xlsx$/i, ''))} › ${esc(t.sheet)}` : '');
    d.innerHTML = `<div class="bmmbox">${head}<div class="impbody">${sheetSel}${tgt}
      <div class="imptool"><button class="btn sm" id="impAll" type="button">전체 선택</button><button class="btn sm" id="impNone" type="button">전체 해제</button><button class="btn sm" id="impNew" type="button">새 항목만</button>
        <label class="chk"><input type="checkbox" id="impNoKw"${imp.noKw ? ' checked' : ''}> 키워드는 가져오지 않기</label><span class="sp"></span><span class="hint">${n} / ${s.entries.length}개 선택</span></div>
      <div id="impL" class="implist">${rows || '<div class="hint" style="padding:12px">불러올 타임라인이 없습니다.</div>'}</div>
      <div class="hint">시간·내용·키워드만 가져옵니다(참고자료·즐겨찾기·키워드 색은 제외). 원본 엑셀은 바꾸지 않으며, 같은 시간의 기존 항목 뒤에 이어 붙이고, 실행 전에 대상 파일을 백업해 둡니다.</div>
      <div class="edbar"><span class="edmsg" id="impM">${esc(imp.msg)}</span><button class="btn sm" type="button" id="impC">닫기</button><button class="btn pri sm" type="button" id="impGo"${n && !imp.busy && (imp.target !== '__new' || (imp.newName.trim() && imp.newWb)) ? '' : ' disabled'}>${n}개를 ${dest ? dest + '에 ' : ''}병합</button></div></div></div>`;
    if (keep) $('#impL').scrollTop = keep;
  };
  d.onclick = async ev => {
    if (ev.target.closest('#impX, #impC')) return d.close();
    const s = sh();
    if (ev.target.closest('#impAll')) { imp.checked = new Set(s.entries.map((_, i) => i)); return render(); }
    if (ev.target.closest('#impNone')) { imp.checked = new Set(); return render(); }
    if (ev.target.closest('#impNew')) { resetChecks(); return render(); }
    if (!ev.target.closest('#impGo') || imp.busy) return;
    const list = s.entries.filter((_, i) => imp.checked.has(i)).map(e => ({ time: e.time, text: e.text, keywords: e.keywords }));
    const isNew = imp.target === '__new', t = tv();
    imp.busy = true; imp.msg = '엑셀에 추가하는 중…'; render();
    try {
      const body = { file: isNew ? imp.newWb : t.wb, sheet: isNew ? '' : t.sheet, entries: list, noKeywords: imp.noKw };
      if (isNew) body.newSheet = { name: imp.newName.trim(), title: s.title, url: s.url, dateText: s.dateText };
      const r = await api('/api/import/apply', body);
      d.close(); await loadAll(true);
      if (S.videos.some(v => v.key === r.key)) openVideo(r.key);
      toast(r.ok ? `${r.added}개의 타임라인을 병합했습니다${r.created ? ' (새 시트 생성)' : ''}.` : `${r.total}개 중 ${r.added}개만 추가하고 멈췄습니다: ${r.error}`, r.ok ? 4500 : 9000);
    } catch (err) { imp.busy = false; imp.msg = err.message; render(); }
  };
  d.onchange = ev => {
    const el = ev.target;
    if (el.id === 'impSheet') { pickSheet(+el.value); return render(); }
    if (el.id === 'impTgt') { imp.target = el.value; resetChecks(); return render(); }
    if (el.id === 'impWb') { imp.newWb = el.value; return render(); }
    if (el.id === 'impNoKw') { imp.noKw = el.checked; return render(); }
    if (el.dataset && el.dataset.i !== undefined) { el.checked ? imp.checked.add(+el.dataset.i) : imp.checked.delete(+el.dataset.i); imp.msg = ''; render(); }
  };
  d.oninput = ev => { if (ev.target.id === 'impNm') { imp.newName = ev.target.value; const b = $('#impGo'); if (b) b.disabled = !imp.checked.size || !imp.newName.trim() || imp.busy; } };
  pickSheet(Math.max(0, imp.scan.sheets.findIndex(x => x.vid && S.videos.some(v => ytId(v.url) === x.vid))));
  render(); d.showModal();
}

/* ---------- 새 엑셀 문서 / 영상(시트) 추가 ---------- */
const SHEET_BAD = /[\[\]:*?\/\\]/g;
function sheetFromTitle(title, taken) {
  let n = String(title || '').replace(SHEET_BAD, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').trim();
  if (!n) n = '새 영상';
  if (n.toLowerCase() === 'history') n += '_';
  n = n.slice(0, 31).trim();
  const low = new Set(taken.map(x => x.toLowerCase()));
  if (!low.has(n.toLowerCase())) return n;
  for (let i = 2; i < 500; i++) {
    const suf = ` (${i})`, c = n.slice(0, 31 - suf.length).trim() + suf;
    if (!low.has(c.toLowerCase())) return c;
  }
  return n;
}
function sheetNameProblem(name, taken) {
  if (!name.trim()) return '시트 이름을 입력해 주세요';
  if (name.length > 31) return `시트 이름은 31자까지 가능합니다 (지금 ${name.length}자)`;
  if (/[\[\]:*?\/\\]/.test(name)) return '시트 이름에는 [ ] : * ? / \\ 를 쓸 수 없습니다';
  if (/^'|'$/.test(name) || name.toLowerCase() === 'history') return '이 이름은 시트 이름으로 쓸 수 없습니다';
  if (taken.some(x => x.toLowerCase() === name.trim().toLowerCase())) return '이미 같은 이름의 시트가 있습니다';
  return '';
}

function openNewDoc(folder) {
  const d = $('#newdoc');
  const tpl = S.lib.template;
  d.innerHTML = `<form method="dialog" class="bmform"><h3>새 엑셀 문서 만들기</h3>
    <label>폴더 <input id="ndF" value="${esc(folder || '')}" autocomplete="off" placeholder="예 : 일상/여행 (비우면 최상위)"></label>
    <label>파일 이름 <input id="ndN" autocomplete="off" placeholder="예 : 국내여행 (.xlsx는 자동으로 붙습니다)"></label>
    <div class="hint">없는 폴더는 새로 만듭니다. ${tpl ? `'${esc(tpl)}'을 복사해서 만듭니다.` : '내장 기본 양식으로 만듭니다. (라이브러리 맨 위 폴더에 <b>Template.xlsx</b>를 두면 그 파일을 복사해서 만듭니다.)'}</div>
    <div class="edbar"><span class="edmsg" id="ndM"></span><button class="btn sm" type="button" id="ndC">취소</button><button class="btn pri sm" type="button" id="ndS">만들고 영상 추가</button></div></form>`;
  d.showModal(); $('#ndN').focus();
  $('#ndC').onclick = () => d.close();
  const go = async () => {
    const msg = $('#ndM'), btn = $('#ndS');
    if (!$('#ndN').value.trim()) { msg.textContent = '파일 이름을 입력해 주세요'; return; }
    btn.disabled = true; msg.textContent = '만드는 중…';
    try {
      const r = await api('/api/doc/create', { folder: $('#ndF').value.trim(), name: $('#ndN').value.trim() });
      d.close(); await loadAll(true);
      toast(`새 문서를 만들었습니다: ${r.path} (${r.template === 'user' ? '내 템플릿 파일 복사' : '내장 양식'})`, 5000);
      openAddVideo(r.path);
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
  $('#ndS').onclick = go;
  d.querySelectorAll('input').forEach(i => i.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
}

function openAddVideo(file) {
  const d = $('#addvid'), f = S.lib.files.find(x => x.path === file);
  if (!f) return toast('문서를 찾지 못했습니다. 새로고침 후 다시 시도해 주세요.');
  const taken = (f.sheets || []).map(x => x.name);
  d.innerHTML = `<form method="dialog" class="bmform"><h3>영상 추가 <span class="hint">— ${esc(file.replace(/\.xlsx$/i, ''))}</span></h3>
    <label>영상 주소 <input id="avU" autocomplete="off" placeholder="유튜브 링크를 붙여넣으세요"></label>
    <div class="avprev"><div id="avP"></div><div class="hint" id="avS">주소를 붙여넣으면 제목과 재생 시간을 자동으로 불러옵니다.</div></div>
    <label>제목 <input id="avT" autocomplete="off"></label>
    <div class="avrow"><label>재생 시간 <input id="avD" autocomplete="off" placeholder="1:23:45"></label>
      <label>업로드 일자 (선택) <input id="avDt" autocomplete="off" placeholder="2026-03-10"></label></div>
    <label>시트 이름 <input id="avN" autocomplete="off" maxlength="40"></label>
    <div class="hint" id="avNh">시트 이름은 제목에서 자동으로 만들며 직접 고칠 수 있습니다. (31자까지, [ ] : * ? / \\ 불가)</div>
    <div class="hint">${(f.sheets || []).some(x => x.status === 'skip' && /템플릿|template/i.test(x.name)) ? '이 문서의 템플릿 시트를 복사해서 만듭니다.' : '이 문서에 템플릿 시트가 없어 내장 기본 양식으로 만듭니다.'} 업로드 일자는 유튜브에서 자동으로 가져올 수 없어 직접 입력해야 합니다. 비워 두면 날짜 정렬에서 맨 뒤로 갑니다.</div>
    <div class="edbar"><span class="edmsg" id="avM"></span><button class="btn sm" type="button" id="avC">취소</button><button class="btn pri sm" type="button" id="avS2">엑셀에 시트 추가</button></div></form>`;
  const edited = { t: false, d: false, n: false };
  let player = null, token = 0, timer = null;
  const stop = () => { token++; clearInterval(timer); try { player && player.destroy(); } catch { /* 무시 */ } player = null; };
  d.onclose = stop;
  d.showModal(); $('#avU').focus();
  const setStatus = t => { $('#avS').textContent = t; };
  const refreshName = () => {
    if (!edited.n) $('#avN').value = sheetFromTitle($('#avT').value, taken);
    const p = sheetNameProblem($('#avN').value, taken);
    $('#avNh').textContent = p || '시트 이름은 제목에서 자동으로 만들며 직접 고칠 수 있습니다. (31자까지, [ ] : * ? / \\ 불가)';
    $('#avNh').classList.toggle('bad', !!p);
  };
  $('#avT').oninput = () => { edited.t = true; refreshName(); };
  $('#avD').oninput = () => { edited.d = true; };
  $('#avN').oninput = () => { edited.n = true; refreshName(); };
  $('#avC').onclick = () => d.close();

  const lookup = async () => {
    const url = $('#avU').value.trim(), id = ytId(url);
    stop(); const my = token;
    $('#avP').innerHTML = '';
    if (!id) { setStatus(url ? '유튜브 주소로 보이지 않습니다. 주소를 확인해 주세요.' : '주소를 붙여넣으면 제목과 재생 시간을 자동으로 불러옵니다.'); return; }
    setStatus('제목과 재생 시간을 불러오는 중…');
    let gotTitle = false, gotDur = false, note = '';
    const fin = () => {
      if (my !== token) return;
      setStatus(gotTitle && gotDur ? '✔ 제목과 재생 시간을 불러왔습니다. 필요하면 고쳐 주세요.'
        : `${gotTitle ? '제목은 불러왔지만' : gotDur ? '재생 시간은 불러왔지만 제목은' : '자동으로 불러오지 못했습니다.'}${gotTitle && !gotDur ? ' 재생 시간은 읽지 못했습니다. 직접 입력해 주세요.' : gotDur ? ' 직접 입력해 주세요.' : ''}${note ? ' (' + note + ')' : ''}`);
    };
    const setTitle = t => { if (t && my === token && !edited.t) { $('#avT').value = t; gotTitle = true; refreshName(); } else if (t) gotTitle = true; };
    const pT = api('/api/yt/info', { url }).then(r => setTitle(r.title)).catch(e => { note = e.message; });
    const pD = (async () => {
      if (!(await loadYtApi()) || my !== token) { note = note || '유튜브 플레이어를 불러오지 못했습니다'; return; }
      $('#avP').innerHTML = '<div id="avPp"></div>';
      await new Promise(res => {
        try {
          player = new YT.Player('avPp', {
            width: '256', height: '144', videoId: id,
            playerVars: { rel: 0, playsinline: 1, origin: /^https?:$/.test(location.protocol) ? location.origin : undefined },
            events: {
              onError: () => { note = '이 영상은 임베드가 막혀 있거나 비공개일 수 있습니다'; res(); },
              onReady: () => {
                let n = 0;
                timer = setInterval(() => {
                  n++;
                  try {
                    const dur = player.getDuration();
                    if (dur > 0 && my === token) {
                      if (!edited.d) $('#avD').value = fmt(Math.round(dur));
                      gotDur = true; try { const t = player.getVideoData().title; if (t && !gotTitle) setTitle(t); } catch { /* 무시 */ }
                      clearInterval(timer); res();
                    }
                  } catch { /* 계속 */ }
                  if (n > 30) { clearInterval(timer); note = note || '라이브이거나 재생 시간을 읽지 못했습니다'; res(); }
                }, 400);
              },
            },
          });
        } catch { res(); }
      });
    })();
    await Promise.allSettled([pT, pD]); fin();
  };
  let deb = null;
  $('#avU').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(lookup, 500); });
  $('#avU').addEventListener('paste', () => { clearTimeout(deb); setTimeout(lookup, 50); });

  $('#avS2').onclick = async () => {
    const msg = $('#avM'), btn = $('#avS2');
    const url = $('#avU').value.trim(), title = $('#avT').value.trim(), name = $('#avN').value.trim();
    if (!url) { msg.textContent = '영상 주소를 입력해 주세요'; return; }
    if (!title) { msg.textContent = '제목을 입력해 주세요'; return; }
    const p = sheetNameProblem(name, taken); if (p) { msg.textContent = p; return; }
    const durTxt = $('#avD').value.trim(), dur = durTxt ? parseTime(durTxt) : null;
    if (durTxt && (dur == null || dur <= 0)) { msg.textContent = '재생 시간 형식을 확인해 주세요 (예: 1:23:45)'; return; }
    btn.disabled = true; msg.textContent = '저장 중…';
    try {
      const r = await api('/api/video/add', { file, sheet: name, title, url, date: $('#avDt').value.trim(), duration: dur });
      d.close(); await loadAll(true);
      if (S.videos.some(v => v.key === r.key)) openVideo(r.key);
      toast(`시트를 추가했습니다: ${name} (${r.base === 'template' ? '템플릿 시트 복사' : '내장 기본 양식'})`, 5000);
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
}

/* ---------- 설정 (라이트/다크 · 테마 색) ---------- */
function openSettings() {
  const d = $('#setdlg'), T = window.TLMTheme;
  if (!T) return toast('테마 파일(theme.js)을 불러오지 못했습니다.');
  const presetOn = (p, t) => p.hue === t.hue && p.sat === t.sat && p.tint === t.tint;
  const draw = () => {
    const t = T.load();
    d.innerHTML = `<div class="bmmbox"><div class="bmh1"><b>⚙️ 설정</b><button class="x" id="stX" title="닫기">✕</button></div>
      <div class="stbody">
        <div class="stsec"><div class="stlb">화면 모드</div>
          <div class="stmode" role="group" aria-label="화면 모드">${[['light', '☀ 라이트'], ['dark', '🌙 다크'], ['system', '🖥 시스템 설정']].map(([k, l]) => `<button class="btn${t.mode === k ? ' on' : ''}" data-mode="${k}" type="button">${l}</button>`).join('')}</div></div>
        <div class="stsec"><div class="stlb">테마 색 <span class="hint">프로그램 전체의 색 톤(기본: 파랑)이 바뀝니다</span></div>
          <div class="stpre">${T.PRESETS.map((p, i) => `<button class="stp${presetOn(p, t) ? ' on' : ''}" data-p="${i}" type="button" style="--pc:hsl(${p.hue} ${Math.max(p.sat, 8)}% 56%)"><i></i>${esc(p.name)}</button>`).join('')}</div>
          <label class="stsl">색상 <input type="range" id="stH" min="0" max="360" value="${t.hue}"><span id="stHv">${Math.round(t.hue)}</span></label>
          <label class="stsl">선명도 <input type="range" id="stS" min="0" max="100" value="${t.sat}"><span id="stSv">${Math.round(t.sat)}</span></label>
          <label class="stsl">배경 색조 <input type="range" id="stT" min="0" max="40" value="${t.tint}"><span id="stTv">${Math.round(t.tint)}</span></label>
          <div class="hint">선명도를 낮추면 차분한 회색 톤이 되고, 배경 색조는 배경·테두리에 색을 얼마나 섞을지 정합니다.</div></div>
        <div class="stsec stprev"><span class="hint">미리보기</span><button class="btn pri sm" type="button">강조 버튼</button><span class="kw">키워드</span><span class="stsel">선택된 항목</span></div>
        <div class="stsec" id="stUpd"><div class="stlb">새 버전 알림</div><div class="hint">불러오는 중…</div></div>
        <div class="edbar"><span class="edmsg hint" style="color:var(--sub)">이 브라우저에 저장됩니다</span><button class="btn sm" id="stReset" type="button">기본값으로</button><button class="btn pri sm" id="stOk" type="button">닫기</button></div>
      </div></div>`;
  };
  const sync = () => {                              // 슬라이더를 움직이는 동안은 다시 그리지 않고 값·강조만 갱신
    const t = T.load();
    $('#stHv').textContent = Math.round(t.hue); $('#stSv').textContent = Math.round(t.sat); $('#stTv').textContent = Math.round(t.tint);
    d.querySelectorAll('.stp').forEach((b, i) => b.classList.toggle('on', presetOn(T.PRESETS[i], t)));
  };
  const updHtml = u => !u ? '<div class="hint">확인하지 못했습니다.</div>' : !u.configured ? '<div class="hint">배포하는 사람이 업데이트 주소를 설정하지 않아 알림 기능이 꺼져 있습니다.</div>'
    : `<label class="chk"><input type="checkbox" id="stUpdOn"${u.enabled ? ' checked' : ''}> 새 버전이 있으면 알려 주기 (하루 한 번 GitHub 확인)</label>
       <div class="hint">현재 v${esc(u.current)}${u.latest ? ` · 최신 ${esc(u.latest)}${u.newer ? ' — <a href="' + esc(u.url) + '" target="_blank" rel="noopener">받으러 가기 ↗</a>' : ' (최신입니다)'}` : ''}${u.error ? ' · ' + esc(u.error) : ''}. 알림만 하며 파일은 자동으로 바꾸지 않습니다. 켜면 확인할 때 IP 주소가 GitHub에 전달됩니다.</div>`;
  const loadUpd = () => api('/api/update').then(u => { S.upd = u; const el = $('#stUpd'); if (el) el.innerHTML = '<div class="stlb">새 버전 알림</div>' + updHtml(u); }).catch(() => {});
  draw(); loadUpd();
  d.oninput = ev => {
    const id = ev.target.id; if (!/^st[HST]$/.test(id)) return;
    T.set({ hue: +$('#stH').value, sat: +$('#stS').value, tint: +$('#stT').value }); sync();
  };
  d.onclick = ev => {
    if (ev.target.closest('#stUpdOn')) { const on = ev.target.closest('#stUpdOn').checked; api('/api/update/config', { enabled: on }).then(u => { S.upd = u; const el = $('#stUpd'); if (el) el.innerHTML = '<div class="stlb">새 버전 알림</div>' + updHtml(u); if (on) checkUpdate(); else $('#updbar').hidden = true; }).catch(e => toast(e.message)); return; }
    if (ev.target.closest('#stX, #stOk')) return d.close();
    if (ev.target.closest('#stReset')) { T.reset(); draw(); return loadUpd(); }
    const m = ev.target.closest('[data-mode]'); if (m) { T.set({ mode: m.dataset.mode }); draw(); return loadUpd(); }
    const p = ev.target.closest('[data-p]'); if (p) { const x = T.PRESETS[+p.dataset.p]; T.set({ hue: x.hue, sat: x.sat, tint: x.tint }); draw(); loadUpd(); }
  };
  if (!d.open) d.showModal();
}
$('#btnSet').onclick = openSettings;

/* ---------- 진단 (하위 항목: 시트 인식 · 점검 · 연결 복구) ---------- */
const DIAG_TABS = [['sheets', '시트 인식'], ['check', '점검'], ['relink', '연결 복구']];
let diagTab = 'sheets';

/* 옛 위치(파일·시트·폴더)를 가리키는 부가 정보(참고자료·즐겨찾기·아이콘·재생시간 지정)를 찾습니다 */
function computeOrphans() {
  const files = new Set(S.lib.files.map(f => f.path)), vkeys = new Set(S.videos.map(v => v.key));
  const dirs = new Set(); S.lib.files.forEach(f => { const p = f.path.split('/'); for (let i = 1; i < p.length; i++) dirs.add(p.slice(0, i).join('/')); });
  const groups = new Map();
  const grp = (kind, id) => { const k = kind + '|' + id; if (!groups.has(k)) groups.set(k, { kind, id, refs: 0, bm: 0, icons: 0, dur: 0, names: new Set() }); return groups.get(k); };
  const byKey = (key, field, n, sheetName) => {
    if (vkeys.has(key)) return;
    const i = key.lastIndexOf('::'); if (i < 0) return;
    const file = key.slice(0, i), sheet = key.slice(i + 2);
    const g = files.has(file) ? grp('sheet', key) : grp('file', file);
    g[field] += n; if (!files.has(file)) g.names.add(sheet);
  };
  for (const [k, v] of Object.entries(S.refs.videos || {})) {
    const nr = Object.values(v.refs || {}).reduce((a, l) => a + l.length, 0);
    if (nr) byKey(k, 'refs', nr);
    if (v.duration) byKey(k, 'dur', 1);
  }
  for (const b of (S.refs.bookmarks?.items || [])) byKey(b.v, 'bm', 1);
  for (const k of Object.keys(S.refs.icons || {})) {
    if (k.startsWith('video:')) byKey(k.slice(6), 'icons', 1);
    else if (k.startsWith('file:')) { const p = k.slice(5); if (!files.has(p)) grp('file', p).icons++; }
    else if (k.startsWith('dir:')) { const p = k.slice(4); if (!dirs.has(p)) grp('dir', p).icons++; }
  }
  const base = p => p.split('/').at(-1).replace(/\.xlsx$/i, '').toLowerCase();
  const okFiles = S.lib.files.filter(f => !f.error).map(f => f.path);
  const list = [...groups.values()].filter(g => g.refs + g.bm + g.icons + g.dur > 0);
  for (const g of list) {
    if (g.kind === 'file') {
      g.cands = okFiles;
      const same = okFiles.filter(p => base(p) === base(g.id));
      const withSheets = okFiles.filter(p => { const sh = new Set((S.lib.files.find(f => f.path === p).sheets || []).map(x => x.name)); return g.names.size && [...g.names].every(n => sh.has(n)); });
      const part = okFiles.filter(p => { const x = base(p), y = base(g.id); return x.includes(y) || y.includes(x); });   // 이름 일부가 겹치는 경우(문서2 → 문서2-변경)
      g.suggest = same.length === 1 ? same[0] : (withSheets.length === 1 ? withSheets[0] : (part.length === 1 ? part[0] : ''));
    } else if (g.kind === 'sheet') {
      const file = g.id.slice(0, g.id.lastIndexOf('::')), sheet = g.id.slice(g.id.lastIndexOf('::') + 2);
      g.cands = S.videos.filter(v => v.wb === file).map(v => v.key);
      const same = g.cands.filter(k => k.slice(k.lastIndexOf('::') + 2).toLowerCase() === sheet.toLowerCase());
      g.suggest = same.length === 1 ? same[0] : '';
    } else {
      g.cands = [...dirs].sort();
      const last = p => p.split('/').at(-1).toLowerCase(), same = g.cands.filter(p => last(p) === last(g.id));
      g.suggest = same.length === 1 ? same[0] : '';
    }
  }
  S.orphans = list;
}
/* 오류 집계 — 빨간 표시의 기준: 읽지 못한 파일 · 끊어진 연결 · 찾을 수 없는 참고자료 · 시간 형식 오류.
   (주소/업로드일 없음은 오류가 아니라 안내라서 세지 않습니다) */
function diagIssues() {
  const read = (S.errors || []).length, orphan = (S.orphans || []).length;
  let miss = 0, bad = 0;
  for (const v of S.videos) {
    bad += v.entries.filter(e => e.bad).length;
    for (const lst of Object.values(S.refs.videos?.[v.key]?.refs || {})) for (const r of lst) if (r.missing) miss++;
  }
  return { read, orphan, miss, bad, total: read + orphan + miss + bad };
}
let _diagPrev = 0;
function updateDiagBadge() {
  const I = diagIssues(), b = $('#btnDiag');
  b.textContent = '🩺 진단' + (I.total ? ` ⚠${I.total}` : '');
  if (I.total > _diagPrev) { b.classList.remove('err'); void b.offsetWidth; }   // 늘어났을 때 강조 애니메이션을 다시 재생
  b.classList.toggle('err', I.total > 0);
  _diagPrev = I.total;
  const parts = [I.read && `읽지 못한 엑셀 ${I.read}개`, I.orphan && `끊어진 연결 ${I.orphan}곳`, I.miss && `찾을 수 없는 참고자료 ${I.miss}개`, I.bad && `시간 형식 오류 ${I.bad}행`].filter(Boolean);
  b.title = I.total ? `확인이 필요한 오류가 있습니다 — ${parts.join(' · ')}` : '오류 없음 · 엑셀의 각 시트가 어떻게 인식되었는지 확인하고, 안 보이는 이유와 끊어진 연결을 점검합니다';
}
function relinkApply(g, target) {
  const R = S.refs; let moved = 0, skipped = 0;
  const mapKey = k => {
    if (g.kind === 'file' && k.startsWith(g.id + '::')) return target + k.slice(g.id.length);
    if (g.kind === 'sheet' && k === g.id) return target;
    return null;
  };
  for (const k of Object.keys(R.videos || {})) {
    const nk = mapKey(k); if (!nk) continue;
    if (R.videos[nk]) {                         // 새 위치에 이미 정보가 있으면 합침 (같은 파일은 중복 안 되게)
      const a = R.videos[nk], o = R.videos[k];
      for (const [ek, lst] of Object.entries(o.refs || {})) { const cur = ((a.refs ??= {})[ek] ??= []); for (const r of lst) if (!cur.some(x => x.path === r.path)) cur.push(r); }
      if (!a.duration && o.duration) a.duration = o.duration;
      delete R.videos[k]; moved++; continue;
    }
    R.videos[nk] = R.videos[k]; delete R.videos[k]; moved++;
  }
  for (const b of (R.bookmarks?.items || [])) { const nk = mapKey(b.v); if (nk) { b.v = nk; moved++; } }
  const ic = R.icons || {};
  for (const k of Object.keys(ic)) {
    let nk = null;
    if (k.startsWith('video:')) { const m = mapKey(k.slice(6)); if (m) nk = 'video:' + m; }
    else if (g.kind === 'file' && k === 'file:' + g.id) nk = 'file:' + target;
    else if (g.kind === 'dir' && k === 'dir:' + g.id) nk = 'dir:' + target;
    if (!nk) continue;
    if (ic[nk]) { delete ic[k]; skipped++; continue; }      // 새 위치에 이미 아이콘이 있으면 그것을 유지하고 옛 것은 정리
    ic[nk] = ic[k]; delete ic[k]; moved++;
  }
  return { moved, skipped };
}
function relinkDrop(g) {
  const R = S.refs;
  const hit = k => (g.kind === 'file' && k.startsWith(g.id + '::')) || (g.kind === 'sheet' && k === g.id);
  for (const k of Object.keys(R.videos || {})) if (hit(k)) delete R.videos[k];
  if (R.bookmarks?.items) R.bookmarks.items = R.bookmarks.items.filter(b => !hit(b.v));
  for (const k of Object.keys(R.icons || {})) {
    if ((k.startsWith('video:') && hit(k.slice(6))) || (g.kind === 'file' && k === 'file:' + g.id) || (g.kind === 'dir' && k === 'dir:' + g.id)) delete R.icons[k];
  }
}
const S_PICK = {};
function diagRelink() {
  const gs = S.orphans || [];
  if (!gs.length) return '<div class="hint">끊어진 연결이 없습니다. 파일을 옮기거나 이름을 바꾸면 여기에 표시됩니다.</div>';
  const kindLabel = { file: '📒 문서(파일)', sheet: '🎞 시트(영상)', dir: '📁 폴더' };
  const rows = gs.map((g, i) => {
    const id = g.kind + '|' + g.id, cur = S_PICK[id] ?? g.suggest;
    const parts = [g.refs && `참고자료 ${g.refs}`, g.bm && `즐겨찾기 ${g.bm}`, g.icons && `아이콘 ${g.icons}`, g.dur && `재생 시간 지정 ${g.dur}`].filter(Boolean).join(' · ');
    const show = c => g.kind === 'sheet' ? c.slice(c.lastIndexOf('::') + 2) : c;
    return `<div class="rl" data-i="${i}"><div class="rlh"><span class="rlk">${kindLabel[g.kind]}</span> <b>${esc(g.kind === 'sheet' ? g.id.replace('::', '  ›  ') : g.id)}</b>
      <div class="hint">옛 위치에 남은 정보: ${esc(parts)}${g.suggest ? ' · 이름이 비슷한 새 위치를 추천해 두었습니다' : ''}</div></div>
      <div class="rla"><select data-sel><option value="">새 위치 선택…</option>${g.cands.map(c => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(show(c))}</option>`).join('')}</select>
      <button class="btn sm pri" data-a="link">연결</button><button class="btn sm" data-a="drop" title="이 연결 정보를 삭제합니다">버리기</button></div></div>`;
  }).join('');
  const nSug = gs.filter(g => (S_PICK[g.kind + '|' + g.id] ?? g.suggest)).length;
  return `<div class="hint">파일·시트·폴더의 위치나 이름을 바꾸면, 거기에 붙여 둔 참고자료·즐겨찾기·아이콘·재생 시간이 옛 위치에 남아 화면에서 사라져 보입니다. 새 위치를 골라 <b>연결</b>하면 그대로 옮겨집니다. (엑셀 파일은 바뀌지 않고 timeline-refs.json만 바뀝니다)</div>
    <div class="rlall"><button class="btn sm pri" data-a="all"${nSug ? '' : ' disabled'}>추천대로 모두 연결 (${nSug})</button></div>${rows}`;
}
function diagSheets() {
  return `<div class="hint">라이브러리 폴더: ${esc(S.lib.root)}</div>` + (S.lib.files.map(f => `<div class="df">📒 ${esc(f.path)}</div>` +
    (f.error ? `<div class="ds err"><span class="st">⚠</span><span class="nt">${esc(f.error)}</span></div>` : '') +
    (f.sheets || []).map(sh => `<div class="ds ${sh.status}"><span class="st">${sh.status === 'ok' ? '✅' : '➖'}</span><span class="nm">${esc(sh.name)}</span><span class="nt">${esc(sh.note)}</span></div>`).join('')).join('')
    || '<div class="hint">읽은 엑셀 파일이 없습니다. 라이브러리 폴더에 .xlsx 파일이 있는지 확인해 주세요.</div>');
}
function diagCheck() {
  const L = S.lib, ign = (L.ignored || []).filter(x => !x.info), tmp = (L.ignored || []).filter(x => x.info);
  const noUrl = S.videos.filter(v => !v.url), noDate = S.videos.filter(v => !v.date), badRows = S.videos.reduce((a, v) => a + v.entries.filter(e => e.bad).length, 0);
  const missRefs = [];
  for (const v of S.videos) for (const [ek, lst] of Object.entries(S.refs.videos?.[v.key]?.refs || {})) for (const r of lst) if (r.missing) missRefs.push({ v, r });
  const sec = (t, body) => `<div class="df">${t}</div>${body}`;
  const item = (ic, a, b, cls = '') => `<div class="ds ${cls}"><span class="st">${ic}</span><span class="nm">${esc(a)}</span><span class="nt">${esc(b)}</span></div>`;
  const I = diagIssues();
  let h = (I.read + I.miss + I.bad ? `<div class="diagsum err">⚠ 확인이 필요한 오류가 ${I.read + I.miss + I.bad}건 있습니다. 아래 빨간 표시 항목을 확인해 주세요.</div>` : `<div class="diagsum ok">✅ 읽기 오류·참고자료 누락·시간 형식 오류가 없습니다.</div>`) + `<div class="hint">읽은 엑셀 ${L.files.filter(f => !f.error).length}개 · 영상 ${S.videos.length}개 · 새 문서 기본 양식: ${L.template ? `내 템플릿 파일 (${esc(L.template)}, 목록에서는 제외)` : '내장 양식 (라이브러리 맨 위 폴더에 Template.xlsx를 두면 새 문서를 그것으로 만듭니다)'}</div>`;
  h += sec('읽지 못한 엑셀 파일', S.errors.length ? S.errors.map(f => item('⚠', f.path, f.error, 'err')).join('') : '<div class="hint">없음</div>');
  h += sec('읽지 않는 파일 (이름·형식 때문에 목록에 안 나오는 경우)', ign.length ? ign.map(x => item('➖', x.path, x.reason)).join('') : '<div class="hint">없음</div>');
  if (tmp.length) h += `<div class="hint">엑셀 임시 파일 ${tmp.length}개(~$…)는 엑셀이 열려 있을 때 생기며 무시해도 됩니다.</div>`;
  h += sec('영상은 보이지만 일부 기능이 제한되는 경우',
    [noUrl.length ? item('🔗', `주소(B2) 없음 ${noUrl.length}개`, '플레이어를 표시할 수 없습니다: ' + noUrl.slice(0, 5).map(v => v.title).join(', ') + (noUrl.length > 5 ? ' 외' : '')) : '',
      noDate.length ? item('📅', `업로드일(B3) 없음 ${noDate.length}개`, '날짜 정렬에서 맨 뒤로 갑니다: ' + noDate.slice(0, 5).map(v => v.title).join(', ') + (noDate.length > 5 ? ' 외' : '')) : '',
      badRows ? item('⏱', `시간 형식 오류 ${badRows}행`, '시트 인식 탭에서 해당 시트를 확인해 주세요', 'err') : ''].join('') || '<div class="hint">없음</div>');
  h += sec('연결된 참고자료 파일을 찾을 수 없음', missRefs.length ? missRefs.slice(0, 50).map(x => item('📎', x.r.name || x.r.path, `${x.v.title} · ${x.r.path}`, 'err')).join('') + (missRefs.length > 50 ? `<div class="hint">…외 ${missRefs.length - 50}개</div>` : '') : '<div class="hint">없음</div>');
  return h;
}
function renderDiag() {
  const I = diagIssues(), nb = { check: I.read + I.miss + I.bad, relink: I.orphan };
  $('#diagTabs').innerHTML = DIAG_TABS.map(([k, t]) => `<button class="dtab${k === diagTab ? ' on' : ''}${nb[k] ? ' haserr' : ''}" data-t="${k}">${t}${nb[k] ? ` <span class="dbadge">${nb[k]}</span>` : ''}</button>`).join('');
  $('#diagBody').innerHTML = diagTab === 'sheets' ? diagSheets() : diagTab === 'check' ? diagCheck() : diagRelink();
}
function openDiag(tab) { diagTab = tab || 'sheets'; renderDiag(); if (!$('#diag').open) $('#diag').showModal(); }
$('#btnDiag').onclick = () => { const I = diagIssues(); openDiag(I.orphan ? 'relink' : (I.read || I.miss || I.bad) ? 'check' : 'sheets'); };
$('#diagTabs').onclick = ev => { const b = ev.target.closest('.dtab'); if (b) { diagTab = b.dataset.t; renderDiag(); } };
$('#diagBody').addEventListener('change', ev => {
  const sel = ev.target.closest('[data-sel]'); if (!sel) return;
  const g = S.orphans[+sel.closest('.rl').dataset.i]; S_PICK[g.kind + '|' + g.id] = sel.value;
});
$('#diagBody').addEventListener('click', async ev => {
  const b = ev.target.closest('[data-a]'); if (!b) return;
  const act = b.dataset.a;
  const pick = g => S_PICK[g.kind + '|' + g.id] ?? g.suggest;
  if (act === 'all') {
    let m = 0, k = 0;
    for (const g of S.orphans) { const t = pick(g); if (t) { const r = relinkApply(g, t); m += r.moved; k += r.skipped; } }
    await persist(); computeOrphans(); updateDiagBadge(); renderSide(); renderDiag();
    return toast(`${m}건을 새 위치로 옮겼습니다.${k ? ` (새 위치에 이미 있던 아이콘 ${k}건은 새 위치의 것을 유지했습니다)` : ''}`, 5000);
  }
  const g = S.orphans[+b.closest('.rl').dataset.i]; if (!g) return;
  if (act === 'link') {
    const t = pick(g); if (!t) return toast('새 위치를 먼저 골라 주세요.');
    const r = relinkApply(g, t);
    await persist(); computeOrphans(); updateDiagBadge(); renderSide(); if (S.selKey) updateAll(); renderDiag();
    return toast(`${r.moved}건을 옮겼습니다.${r.skipped ? ` (새 위치에 이미 있던 아이콘 ${r.skipped}건은 새 위치의 것을 유지했습니다)` : ''}`, 4500);
  }
  if (act === 'drop') {
    if (!await ask({ title: '연결 정보 버리기', msg: `${g.id}\n에 남은 참고자료·즐겨찾기·아이콘·재생 시간 정보를 삭제합니다. 되돌릴 수 없습니다.`, ok: '삭제' })) return;
    relinkDrop(g); await persist(); computeOrphans(); updateDiagBadge(); renderSide(); renderDiag();
    toast('삭제했습니다.');
  }
});
$('#diagClose').onclick = () => $('#diag').close();


/* 전체 검색 */
$('#kwbToggle').onclick = () => {
  const open = $('#kwbPanel').hidden;
  $('#kwbPanel').hidden = !open; $('#kwbToggle').classList.toggle('on', open);
  $('#kwbArrow').textContent = open ? '▴' : '▾';
  if (open) { renderKwBrowse(); $('#kwbFilter').focus(); }
};
$('#kwbFilter').oninput = renderKwBrowse;
$('#kwbSortName').onclick = () => { S.kwbSort = 'name'; renderKwBrowse(); };
$('#kwbSortCnt').onclick = () => { S.kwbSort = 'cnt'; renderKwBrowse(); };
$('#kwbIdx').onclick = ev => {
  const b = ev.target.closest('.ix'); if (!b) return;
  const g = b.dataset.g;
  S.kwbGroup = (g && S.kwbGroup === g) ? '' : g;
  renderKwBrowse();
};
$('#kwbList').addEventListener('click', ev => {
  const el = ev.target.closest('.kwb'); if (!el) return;
  openKwPop(el.dataset.kw, el, {});
});
$('#gq').oninput = () => {
  S.query = $('#gq').value;
  computeHits(); updateSummary(); renderSide();
  if (curVideo() && $('#bar')) {
    const hs = hitList();
    if (hs.length && !hs.some(e => e.key === S.selEntry) && !S.editing) S.selEntry = hs[0].key;
    if (!S.editing) { updateAll(); scrollSel(); }
  }
};
$('#gq').onkeydown = e => {
  if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { $('#gq').value = ''; $('#gq').oninput(); }
};
for (const k of ['text', 'kw', 'ref']) {
  $('#sc-' + k).onchange = () => {
    if (!$('#sc-text').checked && !$('#sc-kw').checked && !$('#sc-ref').checked) { $('#sc-' + k).checked = true; toast('검색 범위는 최소 한 가지가 필요합니다'); return; }
    S.scope[k] = $('#sc-' + k).checked;
    computeHits(); updateSummary(); renderSide(); updateAll();
  };
}
$('#onlyHit').onchange = () => { S.onlyHit = $('#onlyHit').checked; renderSide(); };

/* ---------- 서버 연결 확인 / 엑셀 변경 자동 반영 ---------- */
function setOnline(ok) { $('#offline').style.display = ok ? 'none' : 'block'; }
setInterval(() => fetch('/api/ping').then(r => setOnline(r.ok)).catch(() => setOnline(false)), 10000);
setInterval(async () => {
  if (document.hidden || S.editing || $('dialog[open]')) return;
  try {
    const s = await api('/api/stamp');
    if (s.stamp !== S.stamp) await loadAll(true);
  } catch { /* ping 쪽에서 표시 */ }
}, 3000);

loadAll().catch(err => { $('#main').innerHTML = `<div class="empty"><h2>불러오지 못했습니다</h2><p>${esc(err.message)}</p></div>`; });
