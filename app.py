#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
영상 타임라인 매니저 - 로컬 서버
- 표준 라이브러리만 사용 (추가 설치 불필요)
- 127.0.0.1(내 컴퓨터)에서만 접속 가능
- 엑셀(.xlsx)을 읽기 전용으로 읽고, 참고자료 연결 정보는 timeline-refs.json 에 따로 저장
"""
import glob
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import threading
import time
import webbrowser
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, parse_qs, quote
from urllib.request import Request, urlopen

APP_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(APP_DIR, "web")
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
REFS_NAME = "timeline-refs.json"
REMOVED_NAME = "timeline-refs.removed.json"   # 종료 때 정리된 항목의 보관 파일(복구용)
FIRST_PORT = 8765
APP_VERSION = "1.0.1 (2026-11-20)"

# 새 버전 알림용 GitHub 저장소 ("소유자/저장소"). 배포하는 사람이 여기에 적습니다. 비워 두면 알림 기능이 꺼집니다.
# config.json의 "update_repo"로도 지정할 수 있습니다(그쪽이 우선).
UPDATE_REPO = "ERIM-Hyun/Video-Timeline-Manager"

DEFAULT_CONFIG = {
    "library": os.path.join(APP_DIR, "library"),
    "update_check": True,    # 새 버전 알림 확인 (아래 UPDATE_REPO가 비어 있으면 동작하지 않음)
    "auto_exit_minutes": 3,  # 브라우저가 닫힌 뒤 서버를 자동 종료할 때까지의 시간(분). 0이면 자동 종료 안 함
}

STATE = {"port": FIRST_PORT, "last_beat": time.time(), "server": None}
CACHE = {}  # xlsx 경로 -> ((mtime_ns, size), 파싱 결과)
LOCK = threading.Lock()

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ------------------------------------------------------------------ 설정
def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    except (OSError, ValueError):
        pass
    if os.environ.get("TLM_LIBRARY"):
        cfg["library"] = os.environ["TLM_LIBRARY"]
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def library_root():
    root = os.path.abspath(load_config()["library"])
    os.makedirs(root, exist_ok=True)
    return root


# ------------------------------------------------------------------ xlsx 읽기 (표준 라이브러리)
NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
RID = "{%s}id" % NS["r"]


def _q(tag):
    return "{%s}%s" % (NS["m"], tag)


def _rels(z, path):
    try:
        root = ET.fromstring(z.read(path))
    except KeyError:
        return {}
    return {r.get("Id"): r.get("Target") for r in root}


def _si_text(si):
    parts = []
    for ch in si:
        if ch.tag == _q("t"):
            parts.append(ch.text or "")
        elif ch.tag == _q("r"):
            for t in ch.findall("m:t", NS):
                parts.append(t.text or "")
    return "".join(parts)


def read_xlsx(path):
    """[(시트이름, {셀주소: 값}, {셀주소: 하이퍼링크})] 반환 (숨김 시트 제외)"""
    with open(path, "rb") as f:
        data = f.read()
    z = zipfile.ZipFile(io.BytesIO(data))
    names = set(z.namelist())

    shared = []
    if "xl/sharedStrings.xml" in names:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        shared = [_si_text(si) for si in root.findall("m:si", NS)]

    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = _rels(z, "xl/_rels/workbook.xml.rels")
    sheets = []
    for s in wb.find("m:sheets", NS):
        if s.get("state") in ("hidden", "veryHidden"):
            continue
        target = rels.get(s.get(RID))
        if not target:
            continue
        target = target.lstrip("/") if target.startswith("/") else "xl/" + target
        sheets.append((s.get("name"), target))

    result = []
    for name, target in sheets:
        if target not in names:
            continue
        root = ET.fromstring(z.read(target))
        cells = {}
        for c in root.iter(_q("c")):
            ref, t = c.get("r"), c.get("t")
            v = c.find("m:v", NS)
            val = None
            if t == "s" and v is not None and v.text is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr":
                is_ = c.find("m:is", NS)
                val = _si_text(is_) if is_ is not None else None
            elif t == "str":
                val = v.text if v is not None else None
            elif t == "b":
                val = (v is not None and v.text == "1")
            elif t == "e":
                val = None
            elif v is not None and v.text not in (None, ""):
                try:
                    val = float(v.text)
                except ValueError:
                    val = v.text
            if val is not None:
                cells[ref] = val
        links = {}
        hl = root.find("m:hyperlinks", NS)
        if hl is not None:
            base = target.rsplit("/", 1)
            relpath = "%s/_rels/%s.rels" % (base[0], base[1])
            srels = _rels(z, relpath)
            for h in hl:
                tgt = srels.get(h.get(RID))
                if tgt:
                    links[h.get("ref")] = tgt
        result.append((name, cells, links))
    return result


def read_xlsx_robust(path, tries=3):
    """드라이브 동기화·엑셀 저장 중에는 파일이 잠기거나 덜 써진 상태일 수 있어 몇 번 다시 시도하고,
    그래도 안 되면 임시 폴더로 복사해서 읽습니다."""
    last = None
    for i in range(tries):
        try:
            return read_xlsx(path)
        except (PermissionError, zipfile.BadZipFile, OSError, KeyError) as ex:
            last = ex
            time.sleep(0.4)
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(suffix=".xlsx")
        os.close(fd)
        shutil.copyfile(path, tmp)
        return read_xlsx(tmp)
    except Exception:
        raise last
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


# ------------------------------------------------------------------ 값 해석
def clean_cell(cells, ref):
    v = cells.get(ref)
    if isinstance(v, str):
        v = v.strip()
        if not v or re.fullmatch(r"\(.*\)", v, re.S):  # 비어 있거나 "(내용)" 같은 안내 문구
            return None
    return v


def parse_time(v):
    """'1:02:03', '1;02;03', '12:34', '1시간 2분 3초', 엑셀 시간값 -> 초"""
    if v is None or v == "" or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        # 엑셀 시간값은 '하루=1'인 소수입니다 (예: 45:30 -> 1.8958). 정수(1 이상)는 초로 봅니다.
        if v < 1 or not float(v).is_integer():
            return int(v * 86400 + 0.5)
        return int(v)
    s = re.sub(r"[;；:：]", ":", str(v).strip())
    m = re.fullmatch(r"(\d+):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?", s)
    if m:
        a, b, c = m.groups()
        if c is not None:
            return int(a) * 3600 + int(b) * 60 + int(c)
        return int(a) * 60 + int(b)
    m = re.fullmatch(r"(?:(\d+)\s*시간?)?\s*(?:(\d+)\s*분)?\s*(?:(\d+)\s*초)?", s)
    if m and any(m.groups()):
        h, mi, se = (int(x) if x else 0 for x in m.groups())
        return h * 3600 + mi * 60 + se
    if re.fullmatch(r"\d+", s):
        return int(s)
    return None


def parse_date(v):
    if v is None:
        return "", ""
    if isinstance(v, (int, float)):
        d = date(1899, 12, 30) + timedelta(days=int(v))
        s = d.isoformat()
        return s, s
    s = str(v).strip()
    m = re.search(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})", s) or re.fullmatch(r"(\d{4})(\d{2})(\d{2})", s)
    if m:
        k = "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3)))
        return k, k
    return "", s


def cell_text(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


DURATION_LABEL = re.compile(r"(재생\s*시간|영상\s*길이|총\s*길이|길이)")
TEMPLATE_NAME = re.compile(r"템플릿|template", re.I)


def is_template_sheet(name):
    """시트 이름이 정확히 '템플릿' 또는 'Template'(대소문자 구분 없음, 앞뒤 공백 무시)이면 내용과 상관없이 항상 목록에서 제외"""
    return (name or "").strip().casefold() in ("템플릿", "template")
KEYWORD_LABEL = "키워드"
PLACEHOLDER = re.compile(r"\(.*\)", re.S)


def _col_num(letters):
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def _num_col(n):
    out = ""
    while n:
        n, r = divmod(n - 1, 26)
        out = chr(65 + r) + out
    return out


def _next_col(letters):
    return _num_col(_col_num(letters) + 1)


def find_duration(cells):
    """1~3행 어디든 '재생 시간' 라벨이 있으면 그 오른쪽 칸을 영상 길이(초)로 읽습니다."""
    for ref, v in cells.items():
        m = re.fullmatch(r"([A-Z]+)([1-3])", ref)
        if m and isinstance(v, str) and DURATION_LABEL.fullmatch(v.strip()):
            sec = parse_time(clean_cell(cells, _next_col(m.group(1)) + m.group(2)))
            return sec if sec else None
    return None


def detect_layout(cells):
    """
    시트 양식을 자동으로 인식합니다.
    - 머리글형(신 양식): 어느 행에 '타임라인' 바로 오른쪽 칸이 '내용'이면
      그 행이 머리글이고, 시간 = '타임라인' 열, 내용 = 그 오른쪽 열, 키워드 = 그다음 열부터 오른쪽 끝까지,
      데이터는 머리글 다음 행부터.
    - 기존 양식: 시간 = B열, 내용 = C열, 키워드 = D열부터, 데이터는 4행부터.
    """
    found = []
    for ref, v in cells.items():
        m = re.fullmatch(r"([A-Z]+)(\d+)", ref)
        if m and isinstance(v, str) and v.strip() == "타임라인" and int(m.group(2)) <= 12:
            found.append((int(m.group(2)), _col_num(m.group(1))))
    for row, col in sorted(found):
        right = cells.get("%s%d" % (_num_col(col + 1), row))
        if isinstance(right, str) and right.strip() in ("내용", "메모"):
            return {"time": col, "content": col + 1, "kw": col + 2, "first": row + 1}
    return {"time": 2, "content": 3, "kw": 4, "first": 4}


def content_of(cells, row, col=3):
    """내용 열의 값. 비어 있거나 안내 문구('(여기에 내용을 입력)', '내용')이면 빈 문자열"""
    c = cell_text(cells.get("%s%d" % (_num_col(col), row)))
    if c == "내용" or (c and PLACEHOLDER.fullmatch(c)):
        return ""
    return c


def parse_sheet(wb_path, name, cells, links):
    title = clean_cell(cells, "B1")
    url = links.get("B2") or clean_cell(cells, "B2")
    if is_template_sheet(name):
        return None                                   # 이름이 '템플릿'/'Template'이면 내용이 있어도 항상 제외
    if TEMPLATE_NAME.search(name) and not title and not url:
        # 이름에 '템플릿'이 있고 제목·주소가 아직 비어 있는(안내 문구 그대로인) 시트는 목록에서 제외
        # (템플릿을 복사해 제목·주소를 채우면 '템플릿 (2)' 같은 이름이어도 영상으로 표시)
        return None
    dkey, dtext = parse_date(clean_cell(cells, "B3"))

    L = detect_layout(cells)
    tcol, ccol, kcol, first = L["time"], L["content"], L["kw"], L["first"]
    rows = set()
    kw_by_row = {}  # 행 -> [(열번호, 키워드)]  (키워드 열부터 오른쪽으로 계속)
    for ref, val in cells.items():
        m = re.fullmatch(r"([A-Z]+)(\d+)", ref)
        if not m:
            continue
        col, row = _col_num(m.group(1)), int(m.group(2))
        if row < first:
            continue
        if col in (tcol, ccol):
            rows.add(row)
        elif col >= kcol:
            t = cell_text(val)
            if t and t != KEYWORD_LABEL and not PLACEHOLDER.fullmatch(t):
                kw_by_row.setdefault(row, []).append((col, t))

    valid, bad = [], []
    for row in sorted(rows):
        t = clean_cell(cells, "%s%d" % (_num_col(tcol), row))
        c = content_of(cells, row, ccol)
        if t is None and not c:
            continue
        kws, seen_kw = [], set()
        for _, k in sorted(kw_by_row.get(row, [])):
            if k.lower() not in seen_kw:
                seen_kw.add(k.lower())
                kws.append(k)
        sec = parse_time(t)
        e = {"row": row, "sec": sec, "text": c, "keywords": kws,
             "rawTime": "" if t is None else cell_text(t), "bad": sec is None}
        (bad if sec is None else valid).append(e)

    valid.sort(key=lambda e: (e["sec"], e["row"]))
    seen = {}
    for e in valid:
        n = seen.get(e["sec"], 0)
        seen[e["sec"]] = n + 1
        e["key"] = "%d#%d" % (e["sec"], n)
    for e in bad:
        e["key"] = "bad#%d" % e["row"]

    entries = valid + bad
    if not title and not url and not entries:
        return None
    return {
        "key": "%s::%s" % (wb_path, name),
        "sheet": name,
        "title": cell_text(title) or name,
        "url": cell_text(url),
        "date": dkey,
        "dateText": dtext,
        "duration": find_duration(cells),
        "entries": entries,
    }


# ------------------------------------------------------------------ 엑셀에 내용 저장 (해당 셀 하나만 수정)
def _xml_esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _cell_xml(ref, style, text):
    s = ' s="%s"' % style if style else ""
    if text == "":
        return '<c r="%s"%s/>' % (ref, s)
    return '<c r="%s"%s t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (ref, s, _xml_esc(text))


def set_cell_inline(xml, ref, text):
    """시트 XML 문자열에서 셀 하나만 바꿉니다. 나머지(서식·열 너비·병합 등)는 한 글자도 건드리지 않습니다."""
    m = re.fullmatch(r"([A-Z]+)(\d+)", ref)
    col, rown = m.group(1), int(m.group(2))
    cn = _col_num(col)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text.replace("\r\n", "\n").replace("\r", "\n"))

    row_re = re.compile(r'<row r="%d"([^>]*?)(/>|>(.*?)</row>)' % rown, re.S)
    rm = row_re.search(xml)
    if rm:
        attrs, body = rm.group(1), rm.group(3) or ""
        cm = re.search(r'<c r="%s"([^>]*?)(/>|>.*?</c>)' % ref, body, re.S)
        if cm:
            sm = re.search(r'\bs="(\d+)"', cm.group(1))
            new_body = body[:cm.start()] + _cell_xml(ref, sm.group(1) if sm else None, text) + body[cm.end():]
        else:
            pos = len(body)
            for c in re.finditer(r'<c r="([A-Z]+)\d+"', body):
                if _col_num(c.group(1)) > cn:
                    pos = c.start()
                    break
            new_body = body[:pos] + _cell_xml(ref, None, text) + body[pos:]
            attrs = re.sub(r'\s+spans="[^"]*"', "", attrs)
        new_row = '<row r="%d"%s>%s</row>' % (rown, attrs, new_body)
        xml = xml[:rm.start()] + new_row + xml[rm.end():]
    else:
        new_row = '<row r="%d">%s</row>' % (rown, _cell_xml(ref, None, text))
        pos = None
        for r in re.finditer(r'<row r="(\d+)"', xml):
            if int(r.group(1)) > rown:
                pos = r.start()
                break
        if "<sheetData/>" in xml:
            xml = xml.replace("<sheetData/>", "<sheetData>%s</sheetData>" % new_row, 1)
        elif pos is not None:
            xml = xml[:pos] + new_row + xml[pos:]
        else:
            i = xml.index("</sheetData>")
            xml = xml[:i] + new_row + xml[i:]

    dm = re.search(r'<dimension ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*/>', xml)
    if dm and (_col_num(dm.group(3)) < cn or int(dm.group(4)) < rown):
        new = '<dimension ref="%s%s:%s%d"/>' % (dm.group(1), dm.group(2), _num_col(max(cn, _col_num(dm.group(3)))), max(rown, int(dm.group(4))))
        xml = xml[:dm.start()] + new + xml[dm.end():]
    return xml


def xlsx_write_cell(src, dst, sheet_name, ref, text):
    """src 엑셀을 읽어 셀 하나만 바꾼 새 파일을 dst에 만듭니다. (다른 구성 파일은 그대로 복사)"""
    xlsx_write_cells(src, dst, sheet_name, {ref: text})


def xlsx_write_cells(src, dst, sheet_name, writes):
    """writes = {셀주소: 문자열}. 지정한 셀들만 바꾼 새 파일을 dst에 만듭니다."""
    with zipfile.ZipFile(src) as zin:
        wb = ET.fromstring(zin.read("xl/workbook.xml"))
        rels = _rels(zin, "xl/_rels/workbook.xml.rels")
        target = None
        for sh in wb.find("m:sheets", NS):
            if sh.get("name") == sheet_name:
                t = rels.get(sh.get(RID))
                if t:
                    target = t.lstrip("/") if t.startswith("/") else "xl/" + t
        if not target:
            raise ValueError("시트 '%s'를 찾을 수 없습니다" % sheet_name)
        new_xml = zin.read(target).decode("utf-8-sig")
        for ref, text in writes.items():
            new_xml = set_cell_inline(new_xml, ref, text)
        with zipfile.ZipFile(dst, "w") as zout:
            for info in zin.infolist():
                data = zin.read(info.filename)
                if info.filename == target:
                    data = new_xml.encode("utf-8")
                zout.writestr(info, data, compress_type=info.compress_type)


def backup_file(root, path):
    """저장 직전에 원본을 library/.backup 에 복사 (파일당 최근 10개 유지)"""
    bdir = os.path.join(root, ".backup")
    os.makedirs(bdir, exist_ok=True)
    rel = os.path.relpath(path, root).replace(os.sep, "__")
    shutil.copy2(path, os.path.join(bdir, "%s.%s.bak" % (rel, time.strftime("%Y%m%d-%H%M%S"))))
    for old in sorted(glob.glob(os.path.join(glob.escape(bdir), glob.escape(rel) + ".*.bak")))[:-10]:
        try:
            os.remove(old)
        except OSError:
            pass


class SaveError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


def save_entry_text(root, rel, sheet, row, text, expected):
    path = os.path.normpath(os.path.join(root, rel))
    if not path.startswith(root + os.sep) or not path.lower().endswith(".xlsx") or not os.path.isfile(path):
        raise SaveError(404, "엑셀 파일을 찾을 수 없습니다")
    norm = lambda t: t.replace("\r\n", "\n").replace("\r", "\n").strip()
    try:
        cells = next((c for n, c, _ in read_xlsx_robust(path) if n == sheet), None)
    except PermissionError:
        raise SaveError(423, "엑셀 파일을 읽을 수 없습니다. 엑셀을 저장하고 닫은 뒤 다시 시도해 주세요.")
    if cells is None:
        raise SaveError(404, "시트를 찾을 수 없습니다")
    L = detect_layout(cells)
    if row < L["first"]:
        raise SaveError(400, "수정할 수 없는 행입니다")
    ref = "%s%d" % (_num_col(L["content"]), row)
    if norm(content_of(cells, row, L["content"])) != norm(expected):
        raise SaveError(409, "엑셀에서 이 내용이 먼저 바뀌었습니다. [새로고침] 후 다시 수정해 주세요.")
    tmp = os.path.join(os.path.dirname(path), ".tlm-%d.tmp" % os.getpid())
    try:
        xlsx_write_cell(path, tmp, sheet, ref, text)
        back = next((c for n, c, _ in read_xlsx(tmp) if n == sheet), {})  # 저장 결과 검증
        if norm(cell_text(back.get(ref))) != norm(text):
            raise SaveError(500, "저장 결과 검증에 실패해 원본을 그대로 두었습니다")
        backup_file(root, path)
        os.replace(tmp, path)
    except PermissionError:
        raise SaveError(423, "엑셀에서 이 파일이 열려 있어 저장할 수 없습니다. 엑셀에서 저장하고 닫은 뒤 다시 시도해 주세요.")
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _row_keywords(cells, L, row):
    """행의 키워드 열들을 [(열번호, 글자)]로 (플레이스홀더 포함, 비어 있지 않은 칸만)"""
    out = []
    for ref, val in cells.items():
        m = re.fullmatch(r"([A-Z]+)(\d+)", ref)
        if m and int(m.group(2)) == row and _col_num(m.group(1)) >= L["kw"]:
            t = cell_text(val)
            if t:
                out.append((_col_num(m.group(1)), t))
    return sorted(out)


def _real_keywords(pairs):
    seen, out = set(), []
    for _, t in pairs:
        if t != KEYWORD_LABEL and not PLACEHOLDER.fullmatch(t) and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return out


def clean_keywords(items):
    seen, out = set(), []
    for k in items:
        k = re.sub(r"\s+", " ", str(k)).strip()[:100]
        if k and k.lower() not in seen:
            seen.add(k.lower())
            out.append(k)
    return out[:40]


def save_entry_keywords(root, rel, sheet, row, keywords, expected):
    path = os.path.normpath(os.path.join(root, rel))
    if not path.startswith(root + os.sep) or not path.lower().endswith(".xlsx") or not os.path.isfile(path):
        raise SaveError(404, "엑셀 파일을 찾을 수 없습니다")
    try:
        cells = next((c for n, c, _ in read_xlsx_robust(path) if n == sheet), None)
    except PermissionError:
        raise SaveError(423, "엑셀 파일을 읽을 수 없습니다. 엑셀을 저장하고 닫은 뒤 다시 시도해 주세요.")
    if cells is None:
        raise SaveError(404, "시트를 찾을 수 없습니다")
    L = detect_layout(cells)
    if row < L["first"]:
        raise SaveError(400, "수정할 수 없는 행입니다")
    pairs = _row_keywords(cells, L, row)
    cur = _real_keywords(pairs)
    if [k.lower() for k in cur] != [k.lower() for k in clean_keywords(expected)]:
        raise SaveError(409, "엑셀에서 이 키워드가 먼저 바뀌었습니다. [새로고침] 후 다시 수정해 주세요.")
    new = clean_keywords(keywords)
    writes = {}
    for i, k in enumerate(new):
        writes["%s%d" % (_num_col(L["kw"] + i), row)] = k
    for col, _ in pairs:
        if col >= L["kw"] + len(new):
            writes["%s%d" % (_num_col(col), row)] = ""
    if not writes:
        return
    tmp = os.path.join(os.path.dirname(path), ".tlm-%d.tmp" % os.getpid())
    try:
        xlsx_write_cells(path, tmp, sheet, writes)
        back = next((c for n, c, _ in read_xlsx(tmp) if n == sheet), {})
        if [k.lower() for k in _real_keywords(_row_keywords(back, L, row))] != [k.lower() for k in new]:
            raise SaveError(500, "저장 결과 검증에 실패해 원본을 그대로 두었습니다")
        backup_file(root, path)
        os.replace(tmp, path)
    except PermissionError:
        raise SaveError(423, "엑셀에서 이 파일이 열려 있어 저장할 수 없습니다. 엑셀에서 저장하고 닫은 뒤 다시 시도해 주세요.")
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass



# ------------------------------------------------------------------ 타임라인 추가 (새 행 끼워 넣기)
class NeedAppend(Exception):
    """행을 끼워 넣으면 수식·표 등이 어긋날 수 있어 안전하게 맨 아래에 추가해야 할 때"""


BLOCK_RE = re.compile(r"<(?:tableParts|drawing|legacyDrawing|legacyDrawingHF|oleObjects|controls|extLst)\b")


def _sheet_part(zin, sheet_name):
    wb = ET.fromstring(zin.read("xl/workbook.xml"))
    rels = _rels(zin, "xl/_rels/workbook.xml.rels")
    for sh in wb.find("m:sheets", NS):
        if sh.get("name") == sheet_name:
            t = rels.get(sh.get(RID))
            if t:
                return t.lstrip("/") if t.startswith("/") else "xl/" + t
    raise ValueError("시트 '%s'를 찾을 수 없습니다" % sheet_name)


def xlsx_edit_sheet(src, dst, sheet_name, fn):
    """시트 XML 하나만 fn(xml)->xml 로 바꾼 새 파일을 dst에 만듭니다. (나머지 구성 파일은 그대로 복사)"""
    with zipfile.ZipFile(src) as zin:
        target = _sheet_part(zin, sheet_name)
        out = fn(zin.read(target).decode("utf-8-sig"), zin)
        new_xml, extra = out if isinstance(out, tuple) else (out, {})
        with zipfile.ZipFile(dst, "w") as zout:
            for info in zin.infolist():
                data = zin.read(info.filename)
                if info.filename == target:
                    data = new_xml.encode("utf-8")
                elif info.filename in extra:
                    data = extra[info.filename]
                zout.writestr(info, data, compress_type=info.compress_type)


def _shift_ref_text(text, ins):
    """'A1:C9 E5' 같은 범위 목록에서 ins행 이후의 행 번호를 1씩 늘립니다."""
    def one(m):
        row = int(m.group(2))
        return "%s%d" % (m.group(1), row + 1 if row >= ins else row)
    return re.sub(r"(\$?[A-Z]{1,3}\$?)(\d+)", one, text)


def _insert_row_xml(xml, zin, sheet_name, ins, rown_cells, nb_row):
    """ins행 위치에 새 행을 끼워 넣습니다(아래 행은 한 칸씩 내려감). 위험하면 NeedAppend.
    rown_cells = [(열번호, 'text'|'num', 값)]"""
    if "</sheetData>" not in xml:
        raise NeedAppend("시트에 행이 없습니다")
    if re.search(r"<f[\s>/]", xml):
        raise NeedAppend("시트에 수식이 있습니다")
    if BLOCK_RE.search(xml):
        raise NeedAppend("시트에 표·그림·메모 같은 개체가 있습니다")
    wbx = zin.read("xl/workbook.xml").decode("utf-8", "replace")
    sn = re.escape(_xml_esc(sheet_name))
    extra = {}

    def dn_sub(m):
        if not re.search(r"(?:'%s'|(?<![\w'])%s)!" % (sn, sn), m.group(3)):
            return m.group(0)
        if "_xlnm._FilterDatabase" not in m.group(1):          # 자동 필터가 만드는 숨은 이름만 같이 밀어 줌
            raise NeedAppend("이 시트를 가리키는 이름 정의가 있습니다")
        head_, _, rng = m.group(3).partition("!")
        return "<definedName%s>%s!%s</definedName>" % (m.group(1), head_, _shift_ref_text(rng, ins))
    new_wbx = re.sub(r"<definedName([^>]*)>()([^<]*)</definedName>", dn_sub, wbx)
    if new_wbx != wbx:
        extra["xl/workbook.xml"] = new_wbx.encode("utf-8")
    a = xml.index("<sheetData")
    a_end = xml.index(">", a) + 1
    b = xml.index("</sheetData>")
    head, body, tail = xml[:a_end], xml[a_end:b], xml[b:]

    def row_sub(m):
        n = int(m.group(1))
        if n < ins:
            return m.group(0)
        t = re.sub(r'^<row r="\d+"', '<row r="%d"' % (n + 1), m.group(0))
        return re.sub(r'(<c r="[A-Z]+)%d"' % n, lambda mm: '%s%d"' % (mm.group(1), n + 1), t)
    body = re.sub(r'<row r="(\d+)"[^>]*?(?:/>|>.*?</row>)', row_sub, body, flags=re.S)
    fix = lambda part: re.sub(r'\b(ref|sqref)="([^"]*)"', lambda m: '%s="%s"' % (m.group(1), _shift_ref_text(m.group(2), ins)), part)
    head, tail = fix(head), fix(tail)

    # 새 행의 서식은 이웃 타임스탬프 행에서 가져옵니다(그 행이 아래로 밀렸다면 번호가 +1)
    nbn = nb_row + 1 if nb_row >= ins else nb_row
    rm = re.search(r'<row r="%d"([^>]*?)(?:/>|>(.*?)</row>)' % nbn, body, re.S)
    row_attrs, styles = "", {}
    if rm:
        for k in ("s", "customFormat"):
            am = re.search(r'\b%s="[^"]*"' % k, rm.group(1))
            if am:
                row_attrs += " " + am.group(0)
        for cm in re.finditer(r'<c r="([A-Z]+)%d"([^>]*?)(?:/>|>)' % nbn, rm.group(2) or ""):
            sm = re.search(r'\bs="(\d+)"', cm.group(2))
            if sm:
                styles[_col_num(cm.group(1))] = sm.group(1)
    cells = ""
    for col, kind, val in sorted(rown_cells):
        ref, st = "%s%d" % (_num_col(col), ins), styles.get(col)
        if kind == "num":
            cells += '<c r="%s"%s><v>%s</v></c>' % (ref, ' s="%s"' % st if st else "", repr(float(val)))
        else:
            cells += _cell_xml(ref, st, val)
    new_row = '<row r="%d"%s>%s</row>' % (ins, row_attrs, cells)
    pos = None
    for r in re.finditer(r'<row r="(\d+)"', body):
        if int(r.group(1)) > ins:
            pos = r.start()
            break
    body = body[:pos] + new_row + body[pos:] if pos is not None else body + new_row

    xml = head + body + tail
    maxc = max(c for c, _, _ in rown_cells)
    dm = re.search(r'<dimension ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*/>', xml)
    if dm and _col_num(dm.group(3)) < maxc:
        new = '<dimension ref="%s%s:%s%s"/>' % (dm.group(1), dm.group(2), _num_col(maxc), dm.group(4))
        xml = xml[:dm.start()] + new + xml[dm.end():]
    return xml, extra


def _fmt_time(sec, sample):
    h, m, s = sec // 3600, sec % 3600 // 60, sec % 60
    if re.fullmatch(r"\d{2}:\d{2}:\d{2}", sample or ""):
        return "%02d:%02d:%02d" % (h, m, s)
    return "%d:%02d:%02d" % (h, m, s)


def add_entry(root, rel, sheet, time_text, text, keywords, backup=True):
    """새 타임스탬프를 시간 순서 위치에 끼워 넣습니다. (안전하지 않으면 맨 아래에 추가)"""
    path = os.path.normpath(os.path.join(root, rel))
    if not path.startswith(root + os.sep) or not path.lower().endswith(".xlsx") or not os.path.isfile(path):
        raise SaveError(404, "엑셀 파일을 찾을 수 없습니다")
    sec = parse_time(time_text)
    if sec is None or sec < 0 or sec > 400 * 3600:
        raise SaveError(400, "시간 형식을 확인해 주세요 (예: 1:23:45)")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(text).replace("\r\n", "\n").replace("\r", "\n")).strip()[:5000]
    kws = clean_keywords(keywords)
    try:
        sheets = read_xlsx_robust(path)
    except PermissionError:
        raise SaveError(423, "엑셀 파일을 읽을 수 없습니다. 엑셀을 저장하고 닫은 뒤 다시 시도해 주세요.")
    found = next(((c, l) for n, c, l in sheets if n == sheet), None)
    if found is None:
        raise SaveError(404, "시트를 찾을 수 없습니다")
    cells, links = found
    v = parse_sheet(rel, sheet, cells, links)
    if v is None:
        raise SaveError(400, "템플릿 시트에는 추가할 수 없습니다." if is_template_sheet(sheet) else "목록에서 제외된 시트(템플릿)에는 추가할 수 없습니다. 제목이나 주소를 먼저 입력해 주세요.")
    L = detect_layout(cells)
    tcol, ccol, kcol = L["time"], L["content"], L["kw"]
    entries = v["entries"]
    valid = sorted((e for e in entries if not e["bad"]), key=lambda e: e["row"])
    used = [int(re.fullmatch(r"[A-Z]+(\d+)", r).group(1)) for r in cells if re.fullmatch(r"[A-Z]+\d+", r)]
    last = max([r for r in used if r >= L["first"]] + [L["first"] - 1])
    used_rows = set(used)
    lastentry = max([e["row"] for e in valid] + [L["first"] - 1])
    append_row = lastentry + 1 if (lastentry + 1) not in used_rows else last + 1
    ins, mode, reason = append_row, "append", ""
    if valid:
        if all(a["sec"] <= b["sec"] for a, b in zip(valid, valid[1:])):
            after = next((e for e in valid if e["sec"] > sec), None)
            if after:
                ins, mode = after["row"], "insert"
        else:
            reason = "시트가 시간순으로 정렬되어 있지 않습니다"
    nb = (next((e for e in valid if e["sec"] > sec), None) or (valid[-1] if valid else None))
    sample = nb["rawTime"] if nb else ""
    before = sorted((e["sec"], e["text"], tuple(e["keywords"])) for e in valid)

    def numeric_time(xml):
        if not nb:
            return False
        m = re.search(r'<c r="%s%d"([^>]*?)(?:/>|>)' % (_num_col(tcol), nb["row"]), xml)
        return bool(m) and not re.search(r'\bt="(?:s|str|inlineStr|b|e|d)"', m.group(1)) and "<v>" in xml[m.end():m.end() + 80]

    def build(xml, zin):
        nonlocal ins, mode, reason
        if mode == "insert":
            try:
                num = numeric_time(xml)
                spec = [(tcol, "num", sec / 86400.0) if num else (tcol, "text", _fmt_time(sec, sample)), (ccol, "text", text)]
                spec += [(kcol + i, "text", k) for i, k in enumerate(kws)]
                return _insert_row_xml(xml, zin, sheet, ins, spec, nb["row"])
            except NeedAppend as ex:
                mode, reason, ins = "append", str(ex), append_row
        writes = {"%s%d" % (_num_col(tcol), ins): _fmt_time(sec, sample), "%s%d" % (_num_col(ccol), ins): text}
        for i, k in enumerate(kws):
            writes["%s%d" % (_num_col(kcol + i), ins)] = k
        for ref, t in writes.items():
            xml = set_cell_inline(xml, ref, t)
        return xml

    tmp = os.path.join(os.path.dirname(path), ".tlm-%d.tmp" % os.getpid())
    try:
        xlsx_edit_sheet(path, tmp, sheet, build)
        back = next((c for n, c, _ in read_xlsx(tmp) if n == sheet), {})
        bv = parse_sheet(rel, sheet, back, {})
        after_list = sorted((e["sec"], e["text"], tuple(e["keywords"])) for e in (bv["entries"] if bv else []) if not e["bad"])
        want = sorted(before + [(sec, text, tuple(kws))])
        row_ok = any(e["row"] == ins and e["sec"] == sec and e["text"] == text for e in (bv["entries"] if bv else []))
        if after_list != want or not row_ok:
            raise SaveError(500, "저장 결과 검증에 실패해 원본을 그대로 두었습니다")
        if backup:
            backup_file(root, path)
        os.replace(tmp, path)
    except PermissionError:
        raise SaveError(423, "엑셀에서 이 파일이 열려 있어 저장할 수 없습니다. 엑셀에서 저장하고 닫은 뒤 다시 시도해 주세요.")
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return {"ok": True, "row": ins, "mode": mode, "reason": reason}



# ------------------------------------------------------------------ 다른 사람의 엑셀 불러오기(병합)
MAX_IMPORT_BYTES = 30 * 1024 * 1024        # 불러올 엑셀 파일 크기 상한
MAX_IMPORT_UNZIPPED = 300 * 1024 * 1024    # 압축을 풀었을 때 크기 상한 (압축 폭탄 방지)


def yt_vid(url):
    """유튜브 주소에서 영상 ID를 뽑습니다 (웹 화면의 ytId와 같은 규칙). 없으면 ''."""
    url = (url or "").strip()
    if url and not re.match(r"[a-z]+://", url, re.I):
        url = "https://" + url
    try:
        u = urlparse(url)
    except ValueError:
        return ""
    h = (u.hostname or "").lower()
    h = re.sub(r"^(www\.|m\.)", "", h)
    if h == "youtu.be":
        return u.path.lstrip("/").split("/")[0]
    if h.endswith("youtube.com"):
        v = (parse_qs(u.query).get("v") or [""])[0]
        if v:
            return v
        m = re.match(r"^/(?:shorts|live|embed|v)/([\w-]{6,})", u.path)
        if m:
            return m.group(1)
    return ""


def _check_import_file(path):
    path = os.path.abspath(str(path or "").strip().strip('"'))
    if not path.lower().endswith(".xlsx") or not os.path.isfile(path):
        raise SaveError(404, "엑셀(.xlsx) 파일을 찾을 수 없습니다")
    if os.path.getsize(path) > MAX_IMPORT_BYTES:
        raise SaveError(413, "파일이 너무 큽니다 (30MB 이하만 불러옵니다)")
    try:
        with zipfile.ZipFile(path) as z:
            if sum(i.file_size for i in z.infolist()) > MAX_IMPORT_UNZIPPED:
                raise SaveError(413, "파일 내용이 비정상적으로 큽니다. 불러오지 않습니다")
    except zipfile.BadZipFile:
        raise SaveError(400, "엑셀 파일 형식이 아닙니다 (.xlsx로 저장된 파일인지 확인해 주세요)")
    return path


def import_scan(path):
    """다른 엑셀을 읽기 전용으로 읽어, 영상 시트별 타임라인(시간·내용·키워드)을 돌려줍니다. 원본은 수정하지 않습니다."""
    path = _check_import_file(path)
    try:
        sheets = read_xlsx_robust(path)
    except PermissionError:
        raise SaveError(423, "파일을 읽을 수 없습니다. 엑셀에서 열려 있다면 저장하고 닫은 뒤 다시 시도해 주세요.")
    except Exception:
        raise SaveError(400, "엑셀 파일을 읽지 못했습니다")
    out, skipped = [], []
    for name, cells, links in sheets:
        v = parse_sheet(os.path.basename(path), name, cells, links)
        if v is None:
            skipped.append(name)
            continue
        ents = [{"sec": e["sec"], "time": _fmt_time(e["sec"], ""), "text": e["text"], "keywords": e["keywords"]}
                for e in v["entries"] if not e["bad"] and (e["text"] or e["keywords"])]
        out.append({"sheet": name, "title": v["title"], "url": v["url"], "vid": yt_vid(v["url"]), "dateText": v["dateText"] or "",
                    "entries": ents, "bad": sum(1 for e in v["entries"] if e["bad"])})
    return {"file": os.path.basename(path), "path": path, "sheets": out, "skipped": skipped}


def import_apply(root, rel, sheet, entries, no_keywords=False, new_sheet=None):
    """고른 타임라인을 대상 시트에 시간 순서로 끼워 넣습니다.
    new_sheet={"name","title","url","dateText"}가 있으면 먼저 rel 문서에 새 영상 시트를 만듭니다.
    같은 초에 이미 항목이 있으면 그 뒤에 붙습니다(기존 항목의 참고자료 연결이 밀리지 않음)."""
    path = _safe_xlsx(root, rel)
    if not isinstance(entries, list) or not entries:
        raise SaveError(400, "불러올 타임라인이 없습니다")
    if len(entries) > 2000:
        raise SaveError(400, "한 번에 불러올 수 있는 타임라인은 2000개까지입니다")
    items = []
    for e in entries:
        sec = parse_time(str(e.get("time", "")))
        if sec is None:
            continue
        items.append((sec, str(e.get("text", "")), [] if no_keywords else list(e.get("keywords") or [])))
    items.sort(key=lambda x: x[0])                       # 시간순(같은 초는 원래 순서 유지)
    if not items:
        raise SaveError(400, "시간 형식이 올바른 타임라인이 없습니다")
    created = None
    if new_sheet:
        args = [root, rel, str(new_sheet.get("name", "")), str(new_sheet.get("title", "")), str(new_sheet.get("url", ""))]
        try:
            r = add_video_sheet(*args, str(new_sheet.get("dateText", "")), None)
        except SaveError as ex:
            if "일자" not in ex.msg:
                raise
            r = add_video_sheet(*args, "", None)          # 날짜 형식을 못 읽으면 날짜 없이 만듭니다
        created = r["key"]
        sheet = created.split("::", 1)[1]
    backup_file(root, path)                               # 병합 전 한 번만 백업(.backup 폴더)
    added, err = 0, ""
    for sec, text, kws in items:
        try:
            add_entry(root, rel, sheet, _fmt_time(sec, ""), text, kws, backup=False)
            added += 1
        except SaveError as ex:
            err = ex.msg
            break
    return {"ok": not err, "added": added, "total": len(items), "error": err, "key": "%s::%s" % (rel, sheet), "created": bool(created)}


# ------------------------------------------------------------------ 새 버전 알림 (GitHub 릴리스 확인, 알림만 — 자동 교체 없음)
def _ver_tuple(v):
    m = re.search(r"\d+(?:\.\d+)*", str(v or ""))
    return tuple(int(x) for x in m.group(0).split(".")) if m else ()


def check_update(force=False):
    cfg = load_config()
    repo = str(cfg.get("update_repo") or UPDATE_REPO or "").strip()
    cur = APP_VERSION
    res = {"enabled": bool(cfg.get("update_check", True)) and bool(repo), "configured": bool(repo), "current": cur, "newer": False}
    if not res["enabled"]:
        return res
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        res.update(enabled=False, error="update_repo 형식이 올바르지 않습니다 (예: 소유자/저장소)")
        return res
    c = STATE.get("update_cache")
    if c and c["repo"] == repo and time.time() - c["t"] < 24 * 3600 and not force:
        return dict(res, **c["data"])
    data = {}
    try:
        req = Request("https://api.github.com/repos/%s/releases/latest" % repo,
                      headers={"User-Agent": "VideoTimelineManager", "Accept": "application/vnd.github+json"})
        with urlopen(req, timeout=6) as r:
            d = json.loads(r.read(300000).decode("utf-8", "replace"))
        tag = str(d.get("tag_name") or "")
        url = str(d.get("html_url") or "")
        if not url.startswith("https://github.com/"):
            url = "https://github.com/%s/releases" % repo
        data = {"latest": tag, "url": url, "name": str(d.get("name") or tag)[:100],
                "newer": bool(_ver_tuple(tag)) and _ver_tuple(tag) > _ver_tuple(cur)}
    except HTTPError as ex:
        data = {"error": "새 버전 정보를 찾지 못했습니다" if ex.code == 404 else "GitHub 응답 오류 %d" % ex.code}
    except (URLError, OSError, ValueError):
        data = {"error": "새 버전을 확인하지 못했습니다 (인터넷 연결 확인)"}
    STATE["update_cache"] = {"repo": repo, "t": time.time(), "data": data}
    return dict(res, **data)


# ------------------------------------------------------------------ 새 문서 / 새 영상 시트
BAD_SHEET_CHARS = re.compile(r"[\[\]:*?/\\]")
BAD_FILE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
TEMPLATE_FILES = ("Template.xlsx", "템플릿.xlsx", "_Template.xlsx", "_템플릿.xlsx")   # 라이브러리 맨 위 폴더에서 찾음(대소문자 구분 없음). 이 파일 자체는 목록에서 제외
WS_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
WS_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _safe_xlsx(root, rel):
    path = os.path.normpath(os.path.join(root, rel))
    if not path.startswith(root + os.sep) or not path.lower().endswith(".xlsx") or not os.path.isfile(path):
        raise SaveError(404, "엑셀 파일을 찾을 수 없습니다")
    return path


def clean_sheet_name(name):
    name = (name or "").strip()
    if not name:
        raise SaveError(400, "시트 이름을 입력해 주세요")
    if len(name) > 31:
        raise SaveError(400, "시트 이름은 31자까지 가능합니다 (엑셀 규칙)")
    if BAD_SHEET_CHARS.search(name):
        raise SaveError(400, "시트 이름에는 [ ] : * ? / \\ 를 쓸 수 없습니다 (엑셀 규칙)")
    if name.startswith("'") or name.endswith("'") or name.lower() == "history":
        raise SaveError(400, "이 이름은 시트 이름으로 쓸 수 없습니다 (엑셀 규칙)")
    return name


def _builtin_sheet_xml():
    """내장 기본 양식: A1 제목 · A2 영상 주소 · A3 업로드 일자 / C3 재생 시간 · 4행 머리글(타임라인|내용|키워드)"""
    c = lambda ref, t: _cell_xml(ref, None, t)
    rows = [(1, [c("A1", "제목")]), (2, [c("A2", "영상 주소")]), (3, [c("A3", "업로드 일자"), c("C3", "재생 시간")]),
            (4, [c("A4", "타임라인"), c("B4", "내용"), c("C4", "키워드")])]
    body = "".join('<row r="%d">%s</row>' % (n, "".join(cs)) for n, cs in rows)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="%s"><dimension ref="A1:D4"/>'
            '<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>'
            '<cols><col min="1" max="1" width="14" customWidth="1"/><col min="2" max="2" width="70" customWidth="1"/>'
            '<col min="3" max="4" width="16" customWidth="1"/></cols><sheetData>%s</sheetData></worksheet>') % (MAIN_NS, body)


def _builtin_workbook(dst):
    """내장 양식으로 새 엑셀 파일 만들기 ('템플릿' 시트 1개)"""
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="%s"/>'
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') % WS_CT
    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="%s/officeDocument" Target="xl/workbook.xml"/></Relationships>') % REL_NS
    wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="%s" xmlns:r="%s"><sheets>'
          '<sheet name="템플릿" sheetId="1" r:id="rId1"/></sheets></workbook>') % (MAIN_NS, REL_NS)
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="%s" Target="worksheets/sheet1.xml"/>'
               '<Relationship Id="rId2" Type="%s/styles" Target="styles.xml"/></Relationships>') % (WS_REL_TYPE, REL_NS)
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="%s"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
              '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
              '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
              '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
              '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>') % MAIN_NS
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("xl/workbook.xml", wb)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        z.writestr("xl/styles.xml", styles)
        z.writestr("xl/worksheets/sheet1.xml", _builtin_sheet_xml())


def find_template_file(root):
    try:
        names = {n.lower(): n for n in os.listdir(root)}
    except OSError:
        return None
    for t in TEMPLATE_FILES:
        if t.lower() in names and os.path.isfile(os.path.join(root, names[t.lower()])):
            return names[t.lower()]
    return None


def _clean_part(label, text, maxlen=80):
    text = (text or "").strip()
    if not text or text in (".", "..") or text.startswith(".") or text.startswith("~") or BAD_FILE_CHARS.search(text) or text != text.rstrip(". "):
        raise SaveError(400, "%s에 쓸 수 없는 글자가 있습니다 (\\ / : * ? \" < > | 와 맨 앞의 . ~ 는 불가)" % label)
    if len(text) > maxlen:
        raise SaveError(400, "%s이(가) 너무 깁니다 (%d자까지)" % (label, maxlen))
    return text


def create_workbook(root, folder, filename):
    """폴더(없으면 새로 만듦) 안에 새 엑셀 문서를 만듭니다. 라이브러리 폴더에 '템플릿.xlsx'가 있으면 그것을 복사합니다."""
    parts = [_clean_part("폴더 이름", p) for p in (folder or "").replace("\\", "/").split("/") if p.strip()]
    fn = (filename or "").strip()
    if fn.lower().endswith(".xlsx"):
        fn = fn[:-5]
    fn = _clean_part("파일 이름", fn) + ".xlsx"
    d = os.path.normpath(os.path.join(root, *parts)) if parts else root
    if d != root and not d.startswith(root + os.sep):
        raise SaveError(400, "라이브러리 폴더 밖에는 만들 수 없습니다")
    path = os.path.join(d, fn)
    if os.path.exists(path):
        raise SaveError(409, "같은 이름의 파일이 이미 있습니다")
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, ".tlm-%d.tmp" % os.getpid())
    used = "builtin"
    try:
        tpl = find_template_file(root)
        if tpl:
            try:
                shutil.copyfile(os.path.join(root, tpl), tmp)
                read_xlsx(tmp)                                  # 읽히는지 확인, 안 되면 내장 양식 사용
                used = "user"
            except Exception:
                used = "builtin"
        if used == "builtin":
            _builtin_workbook(tmp)
        os.replace(tmp, path)
    except PermissionError:
        raise SaveError(423, "파일을 만들 수 없습니다. 폴더 권한이나 동기화 상태를 확인해 주세요.")
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return {"ok": True, "path": rel_posix(root, path), "template": used}


def _pick_template_sheet(src):
    """워크북 안에서 복사할 템플릿 시트를 고릅니다. (이름이 '템플릿'/'Template'인 시트 우선, 없으면 이름에 '템플릿'이 있고 제목·주소가 빈 시트. 표·그림 등 개체가 없어야 함)"""
    with zipfile.ZipFile(src) as zin:
        names = set(zin.namelist())
        wb = ET.fromstring(zin.read("xl/workbook.xml"))
        rels = _rels(zin, "xl/_rels/workbook.xml.rels")
        sheets = [(sh.get("name"), rels.get(sh.get(RID))) for sh in wb.find("m:sheets", NS)]
        data = {n: c for n, c, _ in read_xlsx(src)}
        order = [x for x in sheets if is_template_sheet(x[0])] + [x for x in sheets if not is_template_sheet(x[0])]
        for name, t in order:
            if not TEMPLATE_NAME.search(name or "") or not t:
                continue
            cells = data.get(name, {})
            if clean_cell(cells, "B1") or clean_cell(cells, "B2"):
                continue                              # 복사 원본은 제목·주소가 비어 있어야 함(샘플 내용이 새 시트에 딸려 가지 않도록). ( ) 안내 문구는 빈 것으로 봄
            part = t.lstrip("/") if t.startswith("/") else "xl/" + t
            xml = zin.read(part).decode("utf-8-sig")
            relp = part.rsplit("/", 1)[0] + "/_rels/" + part.rsplit("/", 1)[1] + ".rels"
            if relp in names or BLOCK_RE.search(xml):
                continue
            return name, xml, cells
    return None, None, None


def _fmt_dur(sec):
    sec = int(sec)
    return "%d:%02d:%02d" % (sec // 3600, sec % 3600 // 60, sec % 60)


def _add_sheet_file(src, dst, name, title, url, date_key, dur_sec):
    tname, base, tcells = _pick_template_sheet(src)
    used = "template" if base else "builtin"
    if not base:
        base, tcells = _builtin_sheet_xml(), {}
    base = re.sub(r'\s+tabSelected="1"', "", base)
    # 제목·주소·업로드일 입력 (B1~B3). 업로드일이 없으면 안내 문구를 비워 둠
    for ref, t in (("B1", title), ("B2", url), ("B3", date_key or "")):
        base = set_cell_inline(base, ref, t)
    label = next((m for m in ((re.fullmatch(r"([A-Z]+)([1-3])", r)) for r, v in tcells.items()
                  if isinstance(v, str) and DURATION_LABEL.fullmatch(v.strip())) if m), None)
    if label:
        if dur_sec:
            base = set_cell_inline(base, _next_col(label.group(1)) + label.group(2), _fmt_dur(dur_sec))
    elif dur_sec:
        base = set_cell_inline(base, "C3", "재생 시간")
        base = set_cell_inline(base, "D3", _fmt_dur(dur_sec))
    with zipfile.ZipFile(src) as zin:
        wbxml = zin.read("xl/workbook.xml").decode("utf-8-sig")
        relxml = zin.read("xl/_rels/workbook.xml.rels").decode("utf-8-sig")
        ctxml = zin.read("[Content_Types].xml").decode("utf-8-sig")
        wb = ET.fromstring(wbxml.encode("utf-8"))
        shs = list(wb.find("m:sheets", NS))
        if any((sh.get("name") or "").lower() == name.lower() for sh in shs):
            raise SaveError(409, "같은 이름의 시트가 이미 있습니다")
        nums = [int(m.group(1)) for n in zin.namelist() for m in [re.fullmatch(r"xl/worksheets/sheet(\d+)\.xml", n)] if m]
        part = "xl/worksheets/sheet%d.xml" % (max(nums or [0]) + 1)
        rid = "rId%d" % (max([int(x) for x in re.findall(r'Id="rId(\d+)"', relxml)] or [0]) + 1)
        sid = max([int(sh.get("sheetId") or 0) for sh in shs] or [0]) + 1
        pm = re.search(r'<sheet\b[^>]*?\b(\w+):id="', wbxml)
        pre = pm.group(1) if pm else "r"
        esc_name = _xml_esc(name).replace('"', "&quot;")
        if "</sheets>" not in wbxml or "</Relationships>" not in relxml or "</Types>" not in ctxml:
            raise SaveError(500, "이 엑셀 파일의 구조를 처리할 수 없습니다")
        wbxml = wbxml.replace("</sheets>", '<sheet xmlns:%s="%s" name="%s" sheetId="%d" %s:id="%s"/></sheets>' % (pre, REL_NS, esc_name, sid, pre, rid), 1)
        relxml = relxml.replace("</Relationships>", '<Relationship Id="%s" Type="%s" Target="worksheets/%s"/></Relationships>' % (rid, WS_REL_TYPE, part.rsplit("/", 1)[1]), 1)
        ctxml = ctxml.replace("</Types>", '<Override PartName="/%s" ContentType="%s"/></Types>' % (part, WS_CT), 1)
        repl = {"xl/workbook.xml": wbxml, "xl/_rels/workbook.xml.rels": relxml, "[Content_Types].xml": ctxml}
        with zipfile.ZipFile(dst, "w") as zout:
            for info in zin.infolist():
                data = zin.read(info.filename)
                if info.filename in repl:
                    data = repl[info.filename].encode("utf-8")
                zout.writestr(info, data, compress_type=info.compress_type)
            zout.writestr(part, base.encode("utf-8"), compress_type=zipfile.ZIP_DEFLATED)
    return used


def add_video_sheet(root, rel, sheet_name, title, url, date_text, duration):
    """엑셀 문서에 영상 시트 하나를 추가합니다 (템플릿 시트를 복사, 없으면 내장 양식)."""
    path = _safe_xlsx(root, rel)
    name = clean_sheet_name(sheet_name)
    title, url = (title or "").strip(), (url or "").strip()
    if not title:
        raise SaveError(400, "영상 제목을 입력해 주세요")
    if len(title) > 300:
        raise SaveError(400, "영상 제목이 너무 깁니다")
    if not re.match(r"https?://", url, re.I) or len(url) > 500:
        raise SaveError(400, "영상 주소를 확인해 주세요 (https://… 형식)")
    date_key = ""
    if (date_text or "").strip():
        date_key, _ = parse_date(date_text)
        if not date_key:
            raise SaveError(400, "업로드 일자 형식을 확인해 주세요 (예: 2026-03-10)")
    dur = None
    if duration not in (None, "", 0):
        dur = parse_time(duration)
        if dur is None or dur <= 0 or dur > 100 * 3600:
            raise SaveError(400, "재생 시간 형식을 확인해 주세요 (예: 1:23:45)")
    try:
        before = list(read_xlsx_robust(path))
    except PermissionError:
        raise SaveError(423, "엑셀 파일을 읽을 수 없습니다. 엑셀을 저장하고 닫은 뒤 다시 시도해 주세요.")
    tmp = os.path.join(os.path.dirname(path), ".tlm-%d.tmp" % os.getpid())
    try:
        used = _add_sheet_file(path, tmp, name, title, url, date_key, dur)
        after = list(read_xlsx(tmp))                                      # 결과 검증
        if [n for n, _, _ in after][:-1] != [n for n, _, _ in before] or after[-1][0] != name \
                or any(a[1] != b[1] for a, b in zip(after, before)):
            raise SaveError(500, "저장 결과 검증에 실패해 원본을 그대로 두었습니다")
        v = parse_sheet(rel, name, after[-1][1], after[-1][2])
        if not v or v["title"] != title or (dur and v["duration"] != _fmt_dur(dur) and v["duration"] != dur):
            raise SaveError(500, "저장 결과 검증에 실패해 원본을 그대로 두었습니다")
        backup_file(root, path)
        os.replace(tmp, path)
    except PermissionError:
        raise SaveError(423, "엑셀에서 이 파일이 열려 있어 저장할 수 없습니다. 엑셀에서 저장하고 닫은 뒤 다시 시도해 주세요.")
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return {"ok": True, "key": "%s::%s" % (rel, name), "base": used}


def yt_oembed(url):
    """공식 oEmbed로 영상 제목을 가져옵니다 (키 불필요). 재생 시간은 제공되지 않습니다."""
    url = (url or "").strip()
    if not re.match(r"https?://(?:www\.|m\.)?(?:youtube\.com|youtu\.be)/", url, re.I):
        raise SaveError(400, "유튜브 주소가 아닙니다")
    api = "https://www.youtube.com/oembed?format=json&url=" + quote(url, safe="")
    try:
        with urlopen(Request(api, headers={"User-Agent": "VideoTimelineManager"}), timeout=6) as r:
            d = json.loads(r.read(200000).decode("utf-8", "replace"))
    except HTTPError as ex:
        raise SaveError(404, "영상 정보를 찾지 못했습니다 (비공개이거나 주소가 잘못됐을 수 있습니다)" if ex.code in (400, 401, 403, 404) else "유튜브 응답 오류 %d" % ex.code)
    except (URLError, OSError, ValueError):
        raise SaveError(502, "유튜브에 연결할 수 없습니다 (인터넷 연결을 확인해 주세요)")
    return {"title": str(d.get("title", "")), "author": str(d.get("author_name", ""))}


IGN_EXT = {
    ".xls": "예전 엑셀 형식(.xls)이라 읽지 않습니다. 엑셀에서 '.xlsx'로 다시 저장해 주세요.",
    ".xlsm": "매크로 포함 형식(.xlsm)이라 읽지 않습니다. '.xlsx'로 저장해 주세요.",
    ".xlsb": "이진 형식(.xlsb)이라 읽지 않습니다. '.xlsx'로 저장해 주세요.",
    ".csv": "CSV는 시트 구조가 없어 읽지 않습니다. 엑셀로 열어 '.xlsx'로 저장해 주세요.",
    ".ods": "OpenDocument 형식(.ods)이라 읽지 않습니다. '.xlsx'로 저장해 주세요.",
    ".gsheet": "구글 시트 바로가기 파일입니다. 구글 시트에서 '.xlsx'로 다운로드해 주세요.",
    ".numbers": "Numbers 형식이라 읽지 않습니다. '.xlsx'로 내보내 주세요.",
}


def list_ignored(root, limit=200):
    """라이브러리 안에 있지만 읽지 않는 파일과 그 이유 (이름·확장자 때문에 안 보이는 경우를 찾기 위함)"""
    out = []
    for dp, dn, fn in os.walk(root):
        rel_dir = os.path.relpath(dp, root)
        comps = [] if rel_dir == "." else rel_dir.split(os.sep)
        hidden = any(c.startswith(".") for c in comps)
        if ".backup" in comps:
            dn[:] = []
            continue
        dn[:] = sorted(dn)
        for f in sorted(fn):
            low = f.lower()
            ext = os.path.splitext(low)[1]
            r = None
            if hidden and (ext == ".xlsx" or ext in IGN_EXT):
                r = "숨김 폴더(이름이 . 으로 시작) 안에 있어 읽지 않습니다."
            elif f.startswith("~$"):
                r = "엑셀이 파일을 열어 둘 때 만드는 임시 파일입니다. 무시해도 됩니다."
            elif low.startswith(".tlm-") or f == REFS_NAME or f == REMOVED_NAME or f == "config.json":
                continue
            elif f.startswith(".") and ext == ".xlsx":
                r = "이름이 . 으로 시작하는 숨김 파일이라 읽지 않습니다."
            elif ext in IGN_EXT:
                r = IGN_EXT[ext]
            elif low.endswith(".xlsx.xlsx") or (ext == ".xlsx" and f != f.strip()):
                r = "파일 이름이 이상합니다(확장자 중복·공백). 이름을 바꿔 주세요."
            if r:
                out.append({"path": rel_posix(root, os.path.join(dp, f)), "reason": r, "info": f.startswith("~$")})
                if len(out) >= limit:
                    return out
    return out


# ------------------------------------------------------------------ 라이브러리
_TPL_LOWER = {t.lower() for t in TEMPLATE_FILES}


def list_xlsx(root):
    out = []
    for dp, dn, fn in os.walk(root):
        dn[:] = sorted(d for d in dn if not d.startswith("."))
        for f in sorted(fn):
            if f.lower().endswith(".xlsx") and not f.startswith("~$") and not f.startswith("."):
                if dp == root and f.lower() in _TPL_LOWER:
                    continue                          # 라이브러리 맨 위의 Template.xlsx / 템플릿.xlsx는 새 문서용 양식이라 목록에서 제외
                out.append(os.path.join(dp, f))
    return out


def rel_posix(root, path):
    return os.path.relpath(path, root).replace(os.sep, "/")


def library_stamp(root):
    parts = []
    for p in list_xlsx(root):
        try:
            st = os.stat(p)
            parts.append((p, st.st_mtime_ns, st.st_size))
        except OSError:
            pass
    return hashlib.md5(repr(parts).encode("utf-8")).hexdigest()


def _diagnose(name, cells, v):
    """시트 하나가 어떻게 인식되었는지 사람이 읽을 수 있는 설명"""
    L = detect_layout(cells)
    layout = "머리글형" if (L["time"], L["first"]) != (2, 4) else "이전 양식"
    if v:
        bad = sum(1 for e in v["entries"] if e["bad"])
        kws = sum(len(e["keywords"]) for e in v["entries"])
        note = "%s · 타임스탬프 %d개 · 키워드 %d개" % (layout, len(v["entries"]) - bad, kws)
        if bad:
            note += " · 시간 형식 오류 %d행" % bad
        if v["duration"]:
            note += " · 재생 시간 %s" % v["duration"]
        else:
            note += " · 재생 시간 칸 없음/비어 있음(자동 추정)"
        return {"name": name, "status": "ok", "note": note}
    if is_template_sheet(name):
        return {"name": name, "status": "skip", "note": "템플릿 시트라서 항상 제외 (이름이 '템플릿' 또는 'Template')"}
    if TEMPLATE_NAME.search(name):
        return {"name": name, "status": "skip", "note": "템플릿으로 제외 (제목 B1과 주소 B2가 아직 비어 있음)"}
    return {"name": name, "status": "skip", "note": "제외 (제목·주소·타임스탬프가 모두 비어 있음)"}


def load_library():
    root = library_root()
    files = []
    for p in list_xlsx(root):
        rel = rel_posix(root, p)
        try:
            st = os.stat(p)
            sig = (st.st_mtime_ns, st.st_size)
            with LOCK:
                hit = CACHE.get(p)
            if hit and hit[0] == sig:
                videos, skipped_names, diag = hit[1], hit[2], hit[3]
            else:
                videos, skipped_names, diag = [], [], []
                for name, cells, links in read_xlsx_robust(p):
                    v = parse_sheet(rel, name, cells, links)
                    if v:
                        videos.append(v)
                    elif TEMPLATE_NAME.search(name):
                        skipped_names.append(name)
                    diag.append(_diagnose(name, cells, v))
                with LOCK:
                    CACHE[p] = (sig, videos, skipped_names, diag)
            files.append({"path": rel, "videos": videos, "skipped": skipped_names, "sheets": diag})
        except zipfile.BadZipFile:
            files.append({"path": rel, "videos": [], "error": "아직 동기화 중이거나 손상된 파일입니다(드라이브 동기화가 끝나면 자동으로 다시 읽습니다)."})
        except PermissionError:
            files.append({"path": rel, "videos": [], "error": "파일을 읽을 수 없습니다. 엑셀을 저장하고 닫은 뒤 다시 시도해 주세요."})
        except Exception as ex:  # 깨진 파일 등
            files.append({"path": rel, "videos": [], "error": "읽기 실패: %s" % ex})
    return {"root": root, "files": files, "stamp": library_stamp(root), "version": APP_VERSION,
            "template": find_template_file(root), "ignored": list_ignored(root)}


# ------------------------------------------------------------------ 참고자료 저장소 (timeline-refs.json)
def refs_path(root):
    return os.path.join(root, REFS_NAME)


def load_refs(root):
    try:
        with open(refs_path(root), "r", encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("videos"), dict):
            return d
    except (OSError, ValueError):
        pass
    return {"version": 1, "videos": {}}


def resolve_stored(root, p):
    return p if os.path.isabs(p) else os.path.normpath(os.path.join(root, p))


def to_stored(root, p):
    """라이브러리 폴더 안의 파일은 상대경로, 밖의 파일은 절대경로로 저장"""
    p = os.path.abspath(p)
    try:
        if os.path.normcase(os.path.commonpath([root, p])) == os.path.normcase(root):
            return os.path.relpath(p, root).replace(os.sep, "/")
    except ValueError:
        pass
    return p


def annotate(root, refs):
    for v in refs.get("videos", {}).values():
        for lst in v.get("refs", {}).values():
            for r in lst:
                r["missing"] = not os.path.isfile(resolve_stored(root, r.get("path", "")))
    return refs


def clean_bookmarks(bm):
    """즐겨찾기: 폴더(id, name, parent)와 항목(id, v, e, sec, title, name, note, folder, ts)을 검증·정리"""
    if not isinstance(bm, dict):
        return None
    ident = re.compile(r"[A-Za-z0-9_-]{1,40}")
    folders, ids = [], set()
    for f in (bm.get("folders") or [])[:500]:
        if not isinstance(f, dict):
            continue
        fid, name = f.get("id"), str(f.get("name", "")).strip()[:100]
        if not (isinstance(fid, str) and ident.fullmatch(fid)) or not name or fid in ids:
            continue
        ids.add(fid)
        par = f.get("parent")
        folders.append({"id": fid, "name": name, "parent": par if isinstance(par, str) else ""})
    byid = {f["id"]: f for f in folders}
    for f in folders:                      # 없는 부모는 최상위로, 순환은 끊기
        if f["parent"] not in byid:
            f["parent"] = ""
    for f in folders:
        seen, cur = {f["id"]}, f["parent"]
        while cur:
            if cur in seen:
                f["parent"] = ""
                break
            seen.add(cur)
            cur = byid[cur]["parent"]
    items, used = [], set()
    for b in (bm.get("items") or [])[:5000]:
        if not isinstance(b, dict):
            continue
        bid, vk, ek = b.get("id"), b.get("v"), b.get("e")
        if not (isinstance(bid, str) and ident.fullmatch(bid)) or not isinstance(vk, str) or not isinstance(ek, str):
            continue
        if not vk or len(vk) > 400 or not ek or len(ek) > 40 or (vk, ek) in used:
            continue
        used.add((vk, ek))
        sec = b.get("sec")
        fo = b.get("folder")
        ts = b.get("ts")
        items.append({
            "id": bid, "v": vk, "e": ek,
            "sec": int(sec) if isinstance(sec, (int, float)) and not isinstance(sec, bool) and sec >= 0 else None,
            "title": str(b.get("title", ""))[:200],
            "name": str(b.get("name", "")).strip()[:200],
            "note": str(b.get("note", ""))[:1000],
            "folder": fo if isinstance(fo, str) and fo in byid else "",
            "ts": int(ts) if isinstance(ts, (int, float)) and not isinstance(ts, bool) else 0,
        })
    if not folders and not items:
        return None
    return {"folders": folders, "items": items}


def strip_refs(refs):
    out = {"version": 1, "videos": {}}
    kc = {}
    for k, c in (refs.get("keywordColors") or {}).items():
        if isinstance(c, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", c):
            kc[str(k).strip().lower()] = c.lower()
    if kc:
        out["keywordColors"] = kc
    ic = {}
    for k, v in (refs.get("icons") or {}).items():
        if isinstance(k, str) and isinstance(v, str) and 0 < len(k) <= 300:
            v = v.strip()
            if 0 < len(v) <= 16 and not re.search(r"[\x00-\x1f<>&\"']", v):
                ic[k] = v
    if ic:
        out["icons"] = ic
    bm = clean_bookmarks(refs.get("bookmarks"))
    if bm:
        out["bookmarks"] = bm
    for vk, v in refs.get("videos", {}).items():
        nv = {}
        if v.get("duration"):
            nv["duration"] = int(v["duration"])
        rr = {}
        for ek, lst in v.get("refs", {}).items():
            clean = [{"label": str(r.get("label", "")), "path": str(r.get("path", ""))} for r in lst if r.get("path")]
            if clean:
                rr[ek] = clean
        if rr:
            nv["refs"] = rr
        if nv:
            out["videos"][vk] = nv
    return out


def save_refs(root, refs):
    path = refs_path(root)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(refs, f, ensure_ascii=False, indent=2)
    if os.path.exists(path):
        try:
            with open(path, "rb") as a, open(path + ".bak", "wb") as b:
                b.write(a.read())
        except OSError:
            pass
    os.replace(tmp, path)


# ------------------------------------------------------------------ 종료 때 timeline-refs.json 정리
def _nkw(k):
    return unicodedata.normalize("NFC", str(k)).strip().lower()


def tidy_refs(refs, lib, root):
    """현재 엑셀 상태와 맞지 않는 흔적을 걷어낸 새 refs와, 걷어낸 항목(removed)을 돌려줍니다.
    (엑셀 읽기에 문제가 있으면 (None, 이유)) — 드라이브가 덜 동기화됐을 때 멀쩡한 연결을 지우지 않기 위한 안전장치"""
    files = lib.get("files") or []
    if not files:
        return None, "읽은 엑셀이 없어 정리를 건너뜁니다"
    bad = [f["path"] for f in files if f.get("error")]
    if bad:
        return None, "읽지 못한 엑셀이 있어 정리를 건너뜁니다 (%s)" % bad[0]
    vids, used_kw, dirs = {}, set(), set()
    for f in files:
        parts = f["path"].split("/")
        for i in range(1, len(parts)):
            dirs.add("/".join(parts[:i]))
        for v in f.get("videos", []):
            vids[v["key"]] = v
            for e in v.get("entries", []):
                for k in e.get("keywords", []) or []:
                    used_kw.add(_nkw(k))
    ref_files = {k.rsplit("::", 1)[0] for k in refs.get("videos", {}) if "::" in k}
    if len(ref_files) >= 4 and sum(1 for p in ref_files if p in {f["path"] for f in files}) * 2 < len(ref_files):
        return None, "연결된 문서의 절반 이상이 보이지 않아(드라이브 연결 문제일 수 있음) 정리를 건너뜁니다"

    out = json.loads(json.dumps(refs))
    removed = {}

    def drop(kind, key, val):
        removed.setdefault(kind, {})[key] = val

    for vk in list(out.get("videos", {})):
        v = out["videos"][vk]
        if vk not in vids:
            drop("videos", vk, v)
            del out["videos"][vk]
            continue
        ekeys = {e["key"] for e in vids[vk].get("entries", [])}
        for ek in list(v.get("refs", {})):
            if ek not in ekeys:
                removed.setdefault("videos", {}).setdefault(vk, {}).setdefault("refs", {})[ek] = v["refs"].pop(ek)
        if not v.get("refs") and not v.get("duration"):
            del out["videos"][vk]
    bm = out.get("bookmarks")
    if bm and bm.get("items"):
        keep = []
        for b in bm["items"]:
            v = vids.get(b.get("v"))
            ok = False
            if v:
                es = [e for e in v.get("entries", []) if not e.get("bad")]
                ok = any(e["key"] == b.get("e") for e in es)
                if not ok and b.get("sec") is not None:       # 화면(bmTarget)과 같은 기준: 5초 안의 타임스탬프로 이어짐
                    ok = any(abs(e["sec"] - b["sec"]) <= 5 for e in es)
            if ok:
                keep.append(b)
            else:
                removed.setdefault("bookmarks", []).append(b)
        bm["items"] = keep
    ic = out.get("icons") or {}
    for k in list(ic):
        gone = False
        if k.startswith("video:"):
            gone = k[6:] not in vids
        elif k.startswith("file:"):
            gone = k[5:] not in {f["path"] for f in files}
        elif k.startswith("dir:"):
            gone = k[4:] not in dirs and not os.path.isdir(os.path.join(root, k[4:]))
        if gone:
            drop("icons", k, ic.pop(k))
    if "icons" in out and not out["icons"]:
        del out["icons"]
    kc = out.get("keywordColors") or {}
    for k in list(kc):
        if _nkw(k) not in used_kw:
            drop("keywordColors", k, kc.pop(k))
    if "keywordColors" in out and not out["keywordColors"]:
        del out["keywordColors"]
    return out, removed


def archive_removed(root, removed):
    path = os.path.join(root, REMOVED_NAME)
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, list):
            d = []
    except (OSError, ValueError):
        d = []
    d.append({"time": time.strftime("%Y-%m-%d %H:%M:%S"), "removed": removed})
    d = d[-30:]                                           # 최근 30번 분량만 보관
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def cleanup_on_exit():
    """종료할 때: 현재 엑셀 상태를 읽어 timeline-refs.json의 흔적을 정리. 걷어낸 것은 timeline-refs.removed.json에 보관."""
    try:
        root = library_root()
        if not os.path.isfile(refs_path(root)):
            return
        with open(refs_path(root), "r", encoding="utf-8") as f:
            raw = json.load(f)
        refs = strip_refs(raw if isinstance(raw, dict) and isinstance(raw.get("videos"), dict) else {"videos": {}})
        new, removed = tidy_refs(refs, load_library(), root)
        if new is None:
            print("정리 건너뜀: %s" % removed)
            return
        n = sum(len(v) for v in removed.values())
        if not n:
            print("정리할 흔적이 없습니다.")
            return
        archive_removed(root, removed)                    # 보관을 먼저 — 실패하면 정리하지 않음
        save_refs(root, strip_refs(new))
        print("timeline-refs.json 정리: %d개 항목을 보관 파일(%s)로 옮겼습니다." % (n, REMOVED_NAME))
    except Exception as ex:                               # 정리가 실패해도 종료는 막지 않음
        print("종료 정리 실패(무시): %s" % ex)


def registered_paths(root):
    out = set()
    for v in load_refs(root).get("videos", {}).values():
        for lst in v.get("refs", {}).values():
            for r in lst:
                out.add(r.get("path"))
    return out


# ------------------------------------------------------------------ 파일 선택창 (tkinter, 별도 프로세스)
PICK_CODE = r'''
import sys, json
try:
    import tkinter as tk
    from tkinter import filedialog
except Exception:
    print(json.dumps({"error": "tk"})); sys.exit(0)
mode, init = sys.argv[1], sys.argv[2]
root = tk.Tk(); root.withdraw()
try: root.attributes("-topmost", True)
except Exception: pass
root.update()
if mode == "folder":
    r = filedialog.askdirectory(initialdir=init, parent=root, title="라이브러리 폴더 선택")
    out = [r] if r else []
elif mode == "xlsx":
    r = filedialog.askopenfilename(initialdir=init, parent=root, title="불러올 엑셀 선택", filetypes=[("엑셀 문서", "*.xlsx")])
    out = [r] if r else []
else:
    out = list(filedialog.askopenfilenames(initialdir=init, parent=root, title="참고자료 선택"))
root.destroy()
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps({"paths": out}, ensure_ascii=False))
'''


def pick_dialog(mode, init):
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    try:
        r = subprocess.run([sys.executable, "-c", PICK_CODE, mode, init], capture_output=True, env=env, timeout=600)
        return json.loads(r.stdout.decode("utf-8", "replace").strip().splitlines()[-1])
    except Exception:
        return {"error": "tk"}


def os_open(path, reveal=False):
    if sys.platform.startswith("win"):
        if reveal:
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
        else:
            os.startfile(path)  # noqa
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path] if reveal else ["open", path])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(path) if reveal else path])


# ------------------------------------------------------------------ HTTP
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "TLM/1.0"

    def log_message(self, *a):
        pass

    # --- 공통
    def _host_ok(self):
        host = (self.headers.get("Host") or "").lower()
        return host in ("127.0.0.1:%d" % STATE["port"], "localhost:%d" % STATE["port"])

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        self._json({"error": msg}, code)

    # --- GET
    def do_GET(self):
        if not self._host_ok():
            return self._err(403, "forbidden")
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/api/ping":
                STATE["last_beat"] = time.time()
                return self._json({"app": "tlm"})
            if u.path == "/api/library":
                return self._json(load_library())
            if u.path == "/api/update":
                return self._json(check_update((q.get("force") or [""])[0] == "1"))
            if u.path == "/api/stamp":
                return self._json({"stamp": library_stamp(library_root())})
            if u.path == "/api/refs":
                root = library_root()
                return self._json(annotate(root, load_refs(root)))
            if u.path == "/api/file":
                return self._serve_ref_file((q.get("p") or [""])[0])
            if u.path.startswith("/api/"):
                return self._err(404, "not found")
            return self._static(u.path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as ex:
            self._err(500, str(ex))

    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not full.startswith(WEB_DIR + os.sep) or not os.path.isfile(full):
            return self._err(404, "not found")
        with open(full, "rb") as f:
            body = f.read()
        ctype = STATIC_TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_ref_file(self, stored):
        root = library_root()
        if stored not in registered_paths(root):
            return self._err(403, "등록되지 않은 파일입니다")
        full = resolve_stored(root, stored)
        if not os.path.isfile(full):
            return self._err(404, "파일을 찾을 수 없습니다")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype in ("text/html", "application/xhtml+xml", "text/xml", "application/xml"):
            ctype = "text/plain"
        size = os.path.getsize(full)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Security-Policy", "sandbox")  # 파일 안의 스크립트 실행 차단
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(full, "rb") as f:
            while True:
                chunk = f.read(1 << 16)
                if not chunk:
                    break
                self.wfile.write(chunk)

    # --- POST
    def do_POST(self):
        if not self._host_ok() or self.headers.get("X-TLM") != "1":
            return self._err(403, "forbidden")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._err(400, "bad json")
        u = urlparse(self.path).path
        root = library_root()
        try:
            if u == "/api/refs":
                save_refs(root, strip_refs(body))
                return self._json(annotate(root, load_refs(root)))
            if u == "/api/entry/save":
                try:
                    save_entry_text(root, str(body.get("file", "")), str(body.get("sheet", "")),
                                    int(body.get("row")), str(body.get("text", "")), str(body.get("expected", "")))
                except SaveError as ex:
                    return self._err(ex.code, ex.msg)
                return self._json({"ok": True})
            if u == "/api/entry/add":
                kws = body.get("keywords", [])
                if not isinstance(kws, list):
                    return self._err(400, "잘못된 요청입니다")
                try:
                    r = add_entry(root, str(body.get("file", "")), str(body.get("sheet", "")),
                                  str(body.get("time", "")), str(body.get("text", "")), kws)
                except SaveError as ex:
                    return self._err(ex.code, ex.msg)
                return self._json(r)
            if u == "/api/video/add":
                try:
                    r = add_video_sheet(root, str(body.get("file", "")), str(body.get("sheet", "")), str(body.get("title", "")),
                                        str(body.get("url", "")), str(body.get("date", "")), body.get("duration"))
                except SaveError as ex:
                    return self._err(ex.code, ex.msg)
                return self._json(r)
            if u == "/api/doc/create":
                try:
                    r = create_workbook(root, str(body.get("folder", "")), str(body.get("name", "")))
                except SaveError as ex:
                    return self._err(ex.code, ex.msg)
                return self._json(r)
            if u == "/api/yt/info":
                try:
                    return self._json(yt_oembed(str(body.get("url", ""))))
                except SaveError as ex:
                    return self._err(ex.code, ex.msg)
            if u == "/api/entry/keywords":
                kws, exp = body.get("keywords"), body.get("expected")
                if not isinstance(kws, list) or not isinstance(exp, list):
                    return self._err(400, "잘못된 요청입니다")
                try:
                    save_entry_keywords(root, str(body.get("file", "")), str(body.get("sheet", "")),
                                        int(body.get("row")), kws, exp)
                except SaveError as ex:
                    return self._err(ex.code, ex.msg)
                return self._json({"ok": True})
            if u == "/api/pick-file":
                r = pick_dialog("files", root)
                if "paths" in r:
                    r["files"] = [{"path": to_stored(root, p), "name": os.path.basename(p)} for p in r["paths"]]
                return self._json(r)
            if u == "/api/normalize":
                p = str(body.get("path", "")).strip().strip('"')
                if not os.path.isfile(p):
                    return self._err(404, "해당 경로에 파일이 없습니다")
                return self._json({"path": to_stored(root, p), "name": os.path.basename(p)})
            if u == "/api/open":
                p = str(body.get("p", ""))
                if p not in registered_paths(root):
                    return self._err(403, "등록되지 않은 파일입니다")
                full = resolve_stored(root, p)
                if not os.path.isfile(full):
                    return self._err(404, "파일을 찾을 수 없습니다")
                os_open(full, bool(body.get("reveal")))
                return self._json({"ok": True})
            if u == "/api/update/config":
                cfg = load_config(); cfg["update_check"] = bool(body.get("enabled")); save_config(cfg)
                STATE.pop("update_cache", None)
                return self._json(check_update())
            if u == "/api/import/pick":
                return self._json(pick_dialog("xlsx", os.path.expanduser("~")))
            if u == "/api/import/scan":
                try:
                    return self._json(import_scan(body.get("path")))
                except SaveError as ex:
                    return self._err(ex.code, ex.msg)
            if u == "/api/import/apply":
                try:
                    ns = body.get("newSheet") if isinstance(body.get("newSheet"), dict) else None
                    return self._json(import_apply(root, str(body.get("file", "")), str(body.get("sheet", "")),
                                                   body.get("entries"), bool(body.get("noKeywords")), ns))
                except SaveError as ex:
                    return self._err(ex.code, ex.msg)
            if u == "/api/library/pick":
                r = pick_dialog("folder", root)
                return self._json(r)
            if u == "/api/library/set":
                p = os.path.abspath(str(body.get("path", "")).strip().strip('"'))
                if not os.path.isdir(p):
                    return self._err(404, "폴더를 찾을 수 없습니다")
                cfg = load_config()
                cfg["library"] = p
                save_config(cfg)
                return self._json({"ok": True})
            if u == "/api/quit":
                self._json({"ok": True})
                threading.Thread(target=STATE["server"].shutdown, daemon=True).start()
                return
            return self._err(404, "not found")
        except Exception as ex:
            self._err(500, str(ex))


# ------------------------------------------------------------------ 실행
def is_ours(port):
    try:
        with urlopen("http://127.0.0.1:%d/api/ping" % port, timeout=0.6) as r:
            return json.loads(r.read().decode()).get("app") == "tlm"
    except Exception:
        return False


def watchdog():
    minutes = load_config().get("auto_exit_minutes", 3)
    if not minutes:
        return
    while True:
        time.sleep(10)
        if time.time() - STATE["last_beat"] > minutes * 60:
            print("브라우저 창이 닫힌 지 %d분이 지나 서버를 종료합니다." % minutes)
            STATE["server"].shutdown()
            return


def main():
    srv = None
    for port in range(FIRST_PORT, FIRST_PORT + 11):
        if is_ours(port):
            print("이미 실행 중입니다. 브라우저를 엽니다.")
            webbrowser.open("http://127.0.0.1:%d/" % port)
            return
        try:
            STATE["port"] = port
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if srv is None:
        print("사용 가능한 포트를 찾지 못했습니다.")
        return
    STATE["server"] = srv
    STATE["last_beat"] = time.time()
    url = "http://127.0.0.1:%d/" % STATE["port"]
    print("=" * 56)
    print(" 영상 타임라인 매니저 실행 중")
    print(" 주소: %s  (이 컴퓨터에서만 접속됩니다)" % url)
    print(" 라이브러리 폴더: %s" % library_root())
    print(" 종료: 화면의 [종료] 버튼 또는 이 창에서 Ctrl+C")
    print("=" * 56)
    threading.Thread(target=watchdog, daemon=True).start()
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        cleanup_on_exit()
        print("종료했습니다.")


if __name__ == "__main__":
    main()
