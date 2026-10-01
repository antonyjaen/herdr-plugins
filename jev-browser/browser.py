# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "jev-ultrafast @ git+https://github.com/browser-use/jev-ultrafast@1231850a0bf1a0c0341fe408ef1668dbbfdfac46",
#   "pillow>=11,<13",
# ]
# ///
"""A terminal browser for herdr: headless Chrome rendered into the pane (kitty graphics where the
host supports it, truecolor half-blocks elsewhere), used with mouse and keyboard, plus
goals carried out by TypeSafe Jev + a small LLM."""

import base64
import io
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

STATE_DIR = Path(os.environ.get("HERDR_PLUGIN_STATE_DIR") or Path.home() / ".jev-browser")
CONFIG_DIR = Path(os.environ.get("HERDR_PLUGIN_CONFIG_DIR") or STATE_DIR)
PROFILE = STATE_DIR / "chrome-profile"
HOME_URL = "about:blank"


def load_env():
    """KEY=VALUE lines from <config dir>/.env, without overriding the real environment."""
    path = CONFIG_DIR / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def find_chrome():
    if os.environ.get("JEV_CHROME"):
        return os.environ["JEV_CHROME"]
    if sys.platform == "win32":
        roots = [os.environ.get(k) for k in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
        candidates = [Path(r) / "Google/Chrome/Application/chrome.exe" for r in roots if r]
    elif sys.platform == "darwin":
        candidates = [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                      Path("/Applications/Chromium.app/Contents/MacOS/Chromium")]
    else:
        candidates = [Path(p) for n in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
                      if (p := shutil.which(n))]
    for c in candidates:
        if c.exists():
            return str(c)
    sys.exit("Chrome not found. Set JEV_CHROME to the browser executable in the plugin's .env.")


def cdp_alive(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1):
            return True
    except OSError:
        return False


def ensure_chrome():
    """Reuse this plugin's Chrome if it is running, else launch it on a free loopback port.
    The profile is dedicated: the user's everyday Chrome profile is never attached."""
    # Our own record of the port: a second launch on a busy profile just hands off to the
    # running Chrome and ignores its own --remote-debugging-port.
    marker = STATE_DIR / "cdp-port"
    lock = STATE_DIR / "chrome.lock"

    def running():
        try:
            port = int(marker.read_text().strip())
            return port if cdp_alive(port) else None
        except (OSError, ValueError):
            return None

    # Several panes can start at once (layouts, session restore): one launches Chrome, the rest wait for it.
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 30
    while True:
        if port := running():
            return port
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            break
        except FileExistsError:
            try:
                stale = time.time() - lock.stat().st_mtime > 30
            except FileNotFoundError:
                continue
            if stale or time.monotonic() > deadline:
                lock.unlink(missing_ok=True)  # a launcher that died mid-start
            time.sleep(0.2)
    try:
        return launch_chrome(marker)
    finally:
        lock.unlink(missing_ok=True)


def launch_chrome(marker):
    PROFILE.mkdir(parents=True, exist_ok=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    subprocess.Popen(
        [find_chrome(), f"--remote-debugging-port={port}", "--remote-debugging-address=127.0.0.1",
         f"--user-data-dir={PROFILE}", "--headless=new", "--no-first-run", "--no-default-browser-check",
         "--hide-scrollbars", "--disable-blink-features=AutomationControlled", HOME_URL],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        if cdp_alive(port):
            marker.write_text(str(port))
            return port
        time.sleep(0.1)
    sys.exit("Chrome did not open its debugging port. Is another copy of this profile running?")


load_env()
CDP_PORT = ensure_chrome()
os.environ["BU_CDP_URL"] = f"http://127.0.0.1:{CDP_PORT}"
with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=5) as _r:
    import json as _json

    USER_AGENT = _json.load(_r)["User-Agent"].replace("HeadlessChrome", "Chrome")
os.environ["BU_NAME"] = "jev-browser"
os.environ.setdefault("BH_TELEMETRY", "0")
os.environ.setdefault("BH_UPDATE_CHECK", "0")

# Imported after the env above: browser_harness reads BU_* at import time.
from jev_ultrafast import Agent  # noqa: E402
import jev_ultrafast.model as jev_model  # noqa: E402
from browser_harness.helpers import cdp  # noqa: E402
from jev_ultrafast.browser import Browser, StalePage  # noqa: E402
from PIL import Image  # noqa: E402

_post_json = jev_model.post_json


def post_json(url, key, body):
    """Text-helper compatibility: MiniMax puts <think> text in the content unless asked
    to split it out, and reasoning models elsewhere may do the same."""
    if "minimax" in url:
        body = {k: v for k, v in body.items() if k not in {"reasoning", "thinking"}} | {"reasoning_split": True}
    result = _post_json(url, key, body)
    for choice in result.get("choices", []):
        content = (choice.get("message") or {}).get("content")
        if isinstance(content, str):
            choice["message"]["content"] = re.sub(r"(?s)^\s*<think>.*?</think>\s*", "", content)
    return result


jev_model.post_json = post_json

RESET = "\x1b[0m"
DIM = "\x1b[2m"
BOLD = "\x1b[1m"


import hashlib  # noqa: E402
import threading  # noqa: E402
import zlib  # noqa: E402

import term  # noqa: E402

# ── Rendering ────────────────────────────────────────────────────────────────────

KITTY_ID = 7171

# Visible words with their box and colour, viewport coordinates, capped for huge pages.
TEXT_JS = r"""(() => {
  const out = [], W = innerWidth, H = innerHeight, range = document.createRange();
  const rgb = (c) => (c.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
  const push = (x, y, h, color, text) => { const [r, g, b] = rgb(color); out.push([x, y, h, r, g, b, text]); };
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && out.length < 6000) {
    const node = walker.currentNode, text = node.textContent;
    if (!text.trim()) continue;
    const el = node.parentElement;
    if (!el || el.closest('script,style,noscript,svg')) continue;
    const box = el.getBoundingClientRect();
    if (box.bottom < 0 || box.top > H || box.right < 0 || box.left > W) continue;
    if (box.width <= 2 || box.height <= 2) continue;  // visually-hidden (screen-reader only) text
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const re = /\S+/g; let m;
    while ((m = re.exec(text))) {
      range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
      const r = range.getBoundingClientRect();
      if (r.width && r.bottom > 0 && r.top < H && r.right > 0 && r.left < W) push(r.left, r.top, r.height, cs.color, m[0]);
    }
  }
  // Form controls: their 1px borders vanish when the page is shrunk to cells, so report them
  // ([kind, x, y, w, h, checked]) for the renderer to draw explicitly.
  const controls = [];
  for (const el of document.querySelectorAll('input:not([type=hidden]),textarea,select,button,[role=button],[role=checkbox],[role=radio]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const type = (el.getAttribute('type') || '').toLowerCase(), role = el.getAttribute('role');
    const kind = type === 'checkbox' || role === 'checkbox' ? 'check' : type === 'radio' || role === 'radio' ? 'radio'
      : el.tagName === 'SELECT' ? 'select' : el.tagName === 'BUTTON' || role === 'button' || ['submit', 'button', 'reset'].includes(type) ? 'button' : 'field';
    const checked = el.checked || el.getAttribute('aria-checked') === 'true';
    controls.push([kind, r.left, r.top, r.width, r.height, checked ? 1 : 0]);
    if (kind === 'field' || kind === 'select') {
      const value = el.tagName === 'SELECT' ? (el.selectedOptions[0]?.text || '') : type === 'password' ? '•'.repeat(el.value.length) : el.value;
      const shown = value || el.placeholder || '';
      if (shown) push(r.left + parseFloat(cs.paddingLeft || 0), r.top + (r.height - parseFloat(cs.fontSize || 16)) / 2,
        parseFloat(cs.fontSize || 16), value ? cs.color : 'rgb(140,140,140)', shown.slice(0, 200));
    }
  }
  // Pages lazy-load images as they scroll into view, but a headless background tab never counts
  // as "in view": load them up front.
  for (const el of document.querySelectorAll('img[loading=lazy],iframe[loading=lazy]')) el.loading = 'eager';
  return {w: out, c: controls, s: [scrollX, scrollY]};
})()"""
HIDE_TEXT = r"""(() => { if (document.getElementById('__jev_hide')) return;
  const s = document.createElement('style'); s.id = '__jev_hide';
  s.textContent = '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;' +
    'text-shadow:none!important;caret-color:transparent!important}::placeholder{color:transparent!important}';
  (document.head || document.documentElement).appendChild(s); })()"""
SHOW_TEXT = "document.getElementById('__jev_hide')?.remove()"

# Lay text out on the terminal's grid (as browsh does): a monospace font whose advance is exactly one
# cell and a line height of exactly one row, so every word lands on whole cells and lines don't
# alternate between one and two rows apart. {cw}/{ch} are CSS px per cell / per row.
GRID_TEXT = r"""((cw, ch) => {
  let s = document.getElementById('__jev_grid');
  if (s && s.dataset.cw == cw && s.dataset.ch == ch) return;
  if (!s) { s = document.createElement('style'); s.id = '__jev_grid'; (document.head || document.documentElement).appendChild(s); }
  const probe = document.createElement('span');
  probe.style.cssText = 'font:' + Math.round(ch * 0.8) + 'px monospace;position:absolute;visibility:hidden;white-space:pre';
  probe.textContent = 'MMMMMMMMMM'; document.documentElement.appendChild(probe);
  const spacing = cw - probe.getBoundingClientRect().width / 10; probe.remove();
  s.dataset.cw = cw; s.dataset.ch = ch;
  s.textContent = 'body,body *:not(svg):not(svg *){font-family:monospace!important;font-size:' + Math.round(ch * 0.8) +
    'px!important;line-height:' + ch + 'px!important;letter-spacing:' + spacing.toFixed(2) + 'px!important;word-spacing:0!important}';
})(%s, %s)"""
UNGRID_TEXT = "document.getElementById('__jev_grid')?.remove()"
EAGER_IMAGES = ("(document.querySelectorAll('img[loading=lazy],iframe[loading=lazy]').forEach(e => e.loading = 'eager'),"
                " {s: [scrollX, scrollY]})")
DEBUG_LOG = os.environ.get("JEV_DEBUG_LOG")


def kitty_supported(t):
    """Ask the terminal (via herdr) whether it accepts kitty graphics; DA1 bounds the wait."""
    if os.environ.get("JEV_RENDER") in {"kitty", "blocks"}:
        return os.environ["JEV_RENDER"] == "kitty"
    if term.IS_WIN:  # herdr forwards images only to Ghostty/Kitty/WezTerm hosts, never on Windows
        return False
    term.write("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c")
    seen, deadline = "", time.monotonic() + 1.0
    while time.monotonic() < deadline:
        try:
            seen += t.events.get(timeout=0.1)
        except Exception:
            continue
        if "\x1b[?" in seen and "c" in seen.split("\x1b[?")[-1]:
            break
    return "_Gi=31;OK" in seen


class Screen:
    """Draws frames into rows [top, top+rows) and only rewrites rows that changed."""

    def __init__(self, kitty):
        self.kitty = kitty
        self.prev = []

    # Quadrant glyph per 2x2 mask (bit 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right).
    QUADS = " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█"

    def draw(self, img, top, cols, rows, text=None):
        """`text` maps row -> {col: (char, (r, g, b), bg or None)}: real characters over the picture.
        The picture uses quadrant blocks: 2x2 pixels per cell, split into the two best colours."""
        if self.kitty:
            return self.draw_kitty(img, top, cols, rows)
        w = cols * 2
        img = img.convert("RGB").resize((w, rows * 2), Image.Resampling.LANCZOS)
        px = img.tobytes()
        lines, stride, quads = [], w * 3, self.QUADS
        for r in range(rows):
            up, lo = px[2 * r * stride:(2 * r + 1) * stride], px[(2 * r + 1) * stride:(2 * r + 2) * stride]
            chars = (text or {}).get(r, {})
            parts, last = [], None
            for c in range(cols):
                x = c * 6
                quad = (up[x:x + 3], up[x + 3:x + 6], lo[x:x + 3], lo[x + 3:x + 6])
                avg = tuple((quad[0][i] + quad[1][i] + quad[2][i] + quad[3][i]) // 4 for i in range(3))
                if c in chars:
                    ch, fgc, bg = chars[c]
                    if bg == "field":  # form fields: a shade off the page colour, lighter on dark pages
                        d = -18 if sum(avg) > 382 else 26
                        bg = tuple(max(0, min(255, v + d)) for v in avg)
                    br, bgc, bb = bg or avg  # the (text-free) page colour behind the glyph
                    fr, fg, fb = (tuple(max(0, min(255, v + (-90 if sum(avg) > 382 else 90))) for v in avg)
                                  if fgc == "edge" else fgc)
                    if abs((fr + fg + fb) - (br + bgc + bb)) < 120:  # too little contrast: pick black/white
                        fr = fg = fb = 15 if br + bgc + bb > 382 else 240
                    cell = (fr, fg, fb, br, bgc, bb, ch)
                else:
                    # Split the four pixels by brightness; each half gets its mean colour.
                    lum = [p[0] * 2 + p[1] * 5 + p[2] for p in quad]
                    mid = sum(lum) / 4
                    mask = sum(1 << i for i in range(4) if lum[i] > mid)
                    if mask in (0, 15) or max(lum) - min(lum) < 48:
                        cell = (*avg, *avg, " ")
                    else:
                        hi = [quad[i] for i in range(4) if mask >> i & 1]
                        low = [quad[i] for i in range(4) if not mask >> i & 1]
                        fcol = tuple(sum(p[i] for p in hi) // len(hi) for i in range(3))
                        bcol = tuple(sum(p[i] for p in low) // len(low) for i in range(3))
                        cell = (*fcol, *bcol, quads[mask])
                if cell[:6] != (last or (None,))[:6]:
                    parts.append("\x1b[38;2;%d;%d;%dm\x1b[48;2;%d;%d;%dm" % cell[:6])
                last = cell
                parts.append(cell[6])
            lines.append("".join(parts))
        if len(self.prev) != rows:
            self.prev = [None] * rows
        out = []
        for r, line in enumerate(lines):
            if line != self.prev[r]:
                out.append(f"\x1b[{top + r + 1};1H{line}\x1b[0m")
                self.prev[r] = line
        term.write("".join(out))

    def draw_kitty(self, img, top, cols, rows):
        img = img.convert("RGB")
        data = base64.b64encode(zlib.compress(img.tobytes(), 1)).decode()
        chunks = [data[i:i + 4096] for i in range(0, len(data), 4096)] or [""]
        out = [f"\x1b[{top + 1};1H"]
        for i, chunk in enumerate(chunks):
            more = 1 if i < len(chunks) - 1 else 0
            head = (f"a=T,f=24,o=z,s={img.width},v={img.height},i={KITTY_ID},c={cols},r={rows},q=2,C=1,m={more}"
                    if i == 0 else f"m={more}")
            out.append(f"\x1b_G{head};{chunk}\x1b\\")
        term.write("".join(out))

    def reset(self):
        self.prev = []
        if self.kitty:
            term.write(f"\x1b_Ga=d,d=I,i={KITTY_ID},q=2\x1b\\")


# ── Keys forwarded to the page ───────────────────────────────────────────────────

PAGE_KEYS = {  # name -> (key, code, windowsVirtualKeyCode, text)
    "enter": ("Enter", "Enter", 13, "\r"), "tab": ("Tab", "Tab", 9, ""), "backspace": ("Backspace", "Backspace", 8, ""),
    "delete": ("Delete", "Delete", 46, ""), "esc": ("Escape", "Escape", 27, ""), "up": ("ArrowUp", "ArrowUp", 38, ""),
    "down": ("ArrowDown", "ArrowDown", 40, ""), "left": ("ArrowLeft", "ArrowLeft", 37, ""),
    "right": ("ArrowRight", "ArrowRight", 39, ""), "home": ("Home", "Home", 36, ""), "end": ("End", "End", 35, ""),
    "pageup": ("PageUp", "PageUp", 33, ""), "pagedown": ("PageDown", "PageDown", 34, ""),
    "shift+tab": ("Tab", "Tab", 9, ""),
}
MODIFIERS = {"alt": 1, "ctrl": 2, "meta": 4, "shift": 8}

HELP = "Ctrl+L address · Ctrl+G goal · Alt+←/→ back/fwd · Ctrl+R reload · Ctrl+±/0 zoom · Ctrl+Q quit"


class TerminalBrowser:
    def __init__(self, t):
        self.t = t
        self.screen = Screen(kitty_supported(t))
        self.tab = Browser(HOME_URL)
        self.zoom = 1.0
        self.crisp = os.environ.get("JEV_TEXT", "1") != "0"  # real characters for page text
        self.mode = "page"  # page | address | goal
        self.edit = ""
        self.status = HELP
        self.goal_thread = None
        self.goal_stop = threading.Event()
        self.goal_steps = []
        self.last_hash = None
        self.layout()

    # geometry: row 0 = address bar, last row = status, the rest is the page
    def layout(self):
        self.cols, self.rows = term.size()
        self.page_rows = max(4, self.rows - 2)
        # Square pixels in half-block mode: 1 cell = 1 px wide, 2 px tall. ~4 CSS px per cell keeps
        # body text a few cells tall; kitty graphics show real pixels, so they can afford a wider page.
        # Text mode wants one character per cell (~8 CSS px, a normal glyph width); blocks-only mode
        # needs a narrower page so text stays a few cells tall; kitty shows real pixels.
        per_cell = 9 if self.screen.kitty else 8 if self.crisp else 4
        width = max(360, min(2400, round(self.cols * per_cell / self.zoom)))
        self.vw, self.vh = width, max(240, round(width * self.page_rows * 2 / self.cols))
        self.apply_viewport(self.tab)
        self.screen.reset()
        term.write("\x1b[2J")
        self.last_hash = None

    def apply_viewport(self, tab):
        tab.call("Emulation.setDeviceMetricsOverride", width=self.vw, height=self.vh, deviceScaleFactor=1, mobile=False)
        # Headless Chrome announces itself as "HeadlessChrome", which sends sites like DuckDuckGo
        # straight to a bot check; present the regular Chrome identity instead.
        tab.call("Emulation.setUserAgentOverride", userAgent=USER_AGENT)

    def to_page(self, x, y):
        return (x + 0.5) * self.vw / self.cols, (y - 1 + 0.5) * self.vh / self.page_rows

    # ── chrome ──
    def bar(self):
        url = self.current_url()
        if self.mode == "address":
            text, style = f" ⌕ {self.edit}▏", "\x1b[48;2;40;44;52m\x1b[38;2;230;230;230m"
        elif self.mode == "goal":
            text, style = f" ✦ Goal: {self.edit}▏", "\x1b[48;2;46;38;64m\x1b[38;2;235;225;255m"
        else:
            text, style = f" ‹ › ⟳  {url}", "\x1b[48;2;30;32;38m\x1b[38;2;200;204;212m"
        term.write(f"\x1b[1;1H{style}{text[: self.cols].ljust(self.cols)}\x1b[0m")
        status = self.status
        if self.goal_thread:
            status = "✦ " + (self.goal_steps[-1] if self.goal_steps else "thinking…") + "   (Esc stops)"
        term.write(f"\x1b[{self.rows};1H\x1b[48;2;22;24;28m\x1b[38;2;140;146;160m"
                   f"{(' ' + status)[: self.cols].ljust(self.cols)}\x1b[0m")

    def current_url(self):
        try:
            return self.tab.evaluate("location.href") or ""
        except Exception:
            return ""

    def frame(self, force=False):
        # Half-blocks need only cols x 2*rows pixels: let Chrome downscale instead of shipping full frames.
        # 2x the target size, then a Lanczos downscale here: sharper than Chrome's own scaling.
        scale = 1 if self.screen.kitty else min(1.0, 2 * self.cols / self.vw)
        crisp = self.crisp and not self.screen.kitty
        tab = self.tab
        try:
            # Text mode (like browsh): read where every visible word sits, then capture the page with
            # its text hidden so the blocks carry only backgrounds and images.
            if crisp:
                tab.evaluate(GRID_TEXT % (round(self.vw / self.cols, 3), round(self.vh / self.page_rows, 3)))
            else:
                tab.evaluate(UNGRID_TEXT)
            words = tab.evaluate(TEXT_JS) if crisp else tab.evaluate(EAGER_IMAGES)
            if crisp:
                tab.evaluate(HIDE_TEXT)
            # The clip is in document coordinates: start it where the page is scrolled to, or the
            # picture shows the top of the page under text from further down.
            sx, sy = (words or {}).get("s") or (0, 0)
            try:
                shot = tab.call("Page.captureScreenshot", format="jpeg", quality=80, optimizeForSpeed=True,
                                clip={"x": sx, "y": sy, "width": self.vw, "height": self.vh, "scale": scale})["data"]
            finally:
                if crisp:
                    tab.evaluate(SHOW_TEXT)
        except Exception:
            return
        digest = hashlib.sha1((shot + repr(words)).encode()).digest()
        if digest == self.last_hash and not force:
            return
        self.last_hash = digest
        img = Image.open(io.BytesIO(base64.b64decode(shot)))
        self.screen.draw(img, 1, self.cols, self.page_rows, self.place_text(words) if crisp and words else None)

    def place_text(self, page):
        """Map the page script's word boxes and form controls (CSS px) onto the cell grid."""
        cw, ch = self.vw / self.cols, self.vh / self.page_rows
        grid, cursor = {}, {}
        put = lambda row, col, cell: 0 <= row < self.page_rows and 0 <= col < self.cols and grid.setdefault(row, {}).__setitem__(col, cell)  # noqa: E731

        # Controls first, words on top. Fields get a visible fill (their borders don't survive the
        # shrink), selects a ▾, checkboxes/radios an ASCII box so no font can widen them.
        for kind, x, y, w, h, checked in page.get("c", []):
            c0, c1 = int(x // cw), max(int(x // cw), int((x + w - 1) // cw))
            r0, r1 = int(y // ch), max(int(y // ch), int((y + h - 1) // ch))
            if kind in ("check", "radio"):
                mark = ("[x]" if checked else "[ ]") if kind == "check" else ("(•)" if checked else "( )")
                for i, glyph in enumerate(mark):
                    put((r0 + r1) // 2, c0 + i, (glyph, (200, 200, 200), None))
            elif kind in ("field", "select"):
                for row in range(r0, r1 + 1):
                    for col in range(c0, c1 + 1):
                        put(row, col, (" ", (0, 0, 0), "field"))
                    put(row, c0, ("▏", "edge", "field"))
                    put(row, c1, ("▕" if kind == "field" else " ", "edge", "field"))
                if kind == "select":
                    put((r0 + r1) // 2, c1 - 1, ("▾", "edge", "field"))

        # Words left to right per row, each at its own cell or one space after the previous word.
        placed = sorted(((int((y + h / 2) // ch), x, w) for x, y, h, *w in page.get("w", [])), key=lambda t: (t[0], t[1]))
        for row, x, (r, g, b, word) in placed:
            if not 0 <= row < self.page_rows:
                continue
            col = max(int(round(x / cw)), cursor.get(row, -2) + 2)
            under = grid.get(row, {})
            for i, char in enumerate(word):
                if col + i < self.cols and char.isprintable():
                    bg = under.get(col + i, (None, None, None))[2]  # keep a field's fill behind its text
                    put(row, col + i, (char, (r, g, b), bg))
            cursor[row] = col + len(word) - 1
        return grid

    # ── actions ──
    def navigate(self, raw):
        raw = raw.strip()
        if not raw:
            return
        if re.match(r"^[a-z][a-z0-9+.-]*:", raw):
            url = raw
        elif re.match(r"^[\w-]+(\.[\w-]+)+(:\d+)?(/\S*)?$", raw) or raw.startswith("localhost"):
            url = "http://" + raw if raw.startswith("localhost") else "https://" + raw
        else:
            url = "https://duckduckgo.com/?q=" + urllib.request.quote(raw)
        self.tab.call("Page.navigate", url=url)
        self.status = HELP

    def history(self, step):
        self.tab.evaluate(f"history.go({step})")

    def mouse(self, kind, x, y, button="left", buttons=0, clicks=1):
        px, py = self.to_page(x, y)
        self.tab.call("Input.dispatchMouseEvent", type=kind, x=px, y=py, button=button, buttons=buttons,
                      clickCount=clicks)

    def key(self, name):
        mods = 0
        parts = name.split("+")
        base = parts[-1] if parts[-1] else "+"
        for p in parts[:-1]:
            mods |= MODIFIERS.get(p, 0)
        if name == "shift+tab":
            base, mods = "shift+tab", MODIFIERS["shift"]
        if base in PAGE_KEYS:
            key, code, vk, text = PAGE_KEYS[base]
            down = {"type": "keyDown" if text else "rawKeyDown", "key": key, "code": code,
                    "windowsVirtualKeyCode": vk, "modifiers": mods}
            if text:
                down["text"] = text
            self.tab.call("Input.dispatchKeyEvent", **down)
            self.tab.call("Input.dispatchKeyEvent", type="keyUp", key=key, code=code, windowsVirtualKeyCode=vk,
                          modifiers=mods)
        elif len(base) == 1 and mods & (MODIFIERS["ctrl"] | MODIFIERS["alt"]):  # e.g. ctrl+a, ctrl+c in the page
            vk = ord(base.upper())
            self.tab.call("Input.dispatchKeyEvent", type="rawKeyDown", key=base, code=f"Key{base.upper()}",
                          windowsVirtualKeyCode=vk, modifiers=mods,
                          commands={"a": ["selectAll"], "c": ["copy"], "x": ["cut"], "v": ["paste"],
                                    "z": ["undo"]}.get(base, []) if mods & MODIFIERS["ctrl"] else [])
            self.tab.call("Input.dispatchKeyEvent", type="keyUp", key=base, code=f"Key{base.upper()}",
                          windowsVirtualKeyCode=vk, modifiers=mods)

    # ── goals ──
    def start_goal(self, goal):
        if not os.environ.get("TYPESAFE_API_KEY"):
            self.status = "TYPESAFE_API_KEY is not set (environment or the plugin's .env)."
            return
        url = self.current_url()
        if not url.startswith("http"):
            url = "https://duckduckgo.com"
        self.goal_steps, self.goal_stop = [], threading.Event()
        self.goal_thread = threading.Thread(target=self.run_goal, args=(url, goal), daemon=True)
        self.goal_thread.start()

    def run_goal(self, url, goal):
        agent, status, detail = None, "stopped", ""
        try:
            agent = Agent(url, goal)
            self.apply_viewport(agent.browser)
            old, self.tab = self.tab, agent.browser  # show the agent's tab live
            old.close()
            for state in agent.run():
                if state["history"]:
                    h = state["history"][-1]
                    typed = f' "{h["text"]}"' if h.get("text") else ""
                    self.goal_steps.append(f"{h['step']}. {h['kind']} {flat(h['action'])[:60]}{typed}")
                if self.goal_stop.is_set():
                    break
            else:
                status = agent.state["status"]
        except Exception as err:
            status, detail = "error", f": {err}"
        n = len(agent.state["history"]) if agent else 0
        ms = agent.state["elapsed_ms"] if agent else 0
        self.status = f"Goal {status} — {n} actions in {ms / 1000:.1f}s{detail}"
        self.goal_thread = None

    # ── input ──
    def handle(self, ev):
        kind = ev[0]
        if kind == "key" and ev[1] == "ctrl+q":
            return False
        if self.goal_thread:
            if kind == "key" and ev[1] in {"esc", "ctrl+c"}:
                self.goal_stop.set()
                self.goal_steps.append("stopping after this step…")
            return True
        if self.mode in {"address", "goal"}:
            return self.handle_edit(ev)
        if kind == "key":
            name = ev[1]
            if name == "ctrl+l":
                self.mode, self.edit = "address", self.current_url()
            elif name == "ctrl+g":
                self.mode, self.edit = "goal", ""
            elif name in {"alt+left"}:
                self.history(-1)
            elif name in {"alt+right"}:
                self.history(1)
            elif name == "ctrl+t":  # toggle real-text rendering vs pure blocks
                self.crisp = not self.crisp
                self.layout()
            elif name in {"ctrl+r", "f5"}:
                self.tab.call("Page.reload")
            elif name in {"ctrl+=", "ctrl++", "ctrl+-", "ctrl+0"}:
                self.zoom = {"ctrl+-": max(0.4, self.zoom / 1.25), "ctrl+0": 1.0}.get(name, min(3.0, self.zoom * 1.25))
                self.layout()
            else:
                self.key(name)
        elif kind == "text":
            self.tab.call("Input.insertText", text=ev[1])
        elif kind == "paste":
            self.tab.call("Input.insertText", text=ev[1])
        elif kind == "mouse":
            _, button, x, y, pressed, moving, _mods = ev
            if y == 0 and pressed and not moving:  # address bar: ‹ back, › forward, ⟳ reload, else edit
                if x <= 2:
                    self.history(-1)
                elif x <= 4:
                    self.history(1)
                elif x <= 6:
                    self.tab.call("Page.reload")
                else:
                    self.mode, self.edit = "address", self.current_url()
                return True
            if not (1 <= y <= self.page_rows):
                return True
            name = ["left", "middle", "right", "none"][button]
            mask = {"left": 1, "right": 2, "middle": 4}.get(name, 0)
            if moving:
                self.mouse("mouseMoved", x, y, button=name, buttons=mask)
            else:
                self.mouse("mousePressed" if pressed else "mouseReleased", x, y, button=name,
                           buttons=mask if pressed else 0)
        elif kind == "wheel":
            _, direction, x, y, _mods = ev
            px, py = self.to_page(x, max(1, y))
            self.tab.call("Input.dispatchMouseEvent", type="mouseWheel", x=px, y=py, deltaX=0, deltaY=direction * 120)
        return True

    def handle_edit(self, ev):
        kind = ev[0]
        if kind in {"text", "paste"}:
            self.edit += ev[1]
        elif kind == "key":
            name = ev[1]
            if name == "esc":
                self.mode = "page"
            elif name == "backspace":
                self.edit = self.edit[:-1]
            elif name == "ctrl+u":
                self.edit = ""
            elif name == "enter":
                mode, text, self.mode = self.mode, self.edit, "page"
                self.navigate(text) if mode == "address" else self.start_goal(text)
        elif kind == "mouse" and ev[4] and ev[3] != 0:
            self.mode = "page"
        return True

    # ── loop ──
    def run(self, start):
        if start:
            self.navigate(start)
        self.closing = False
        threading.Thread(target=self.render_loop, daemon=True).start()
        last = 0.0
        while True:
            # Drain every pending chunk before drawing, so typing never waits on a frame.
            chunks = []
            try:
                chunks.append(self.t.events.get(timeout=0.03))
                while True:
                    chunks.append(self.t.events.get_nowait())
            except Exception:
                pass
            events = term.parse("".join(chunks)) if chunks else []
            for ev in events:
                try:
                    if not self.handle(ev):
                        return
                except Exception as err:
                    self.status = f"{type(err).__name__}: {err}"
            if events:
                self.bar()  # instant feedback for the address/goal line
            if term.size() != (self.cols, self.rows):
                self.layout()
            if time.monotonic() - last > 1.0:  # keep the URL current after in-page navigation
                last = time.monotonic()
                self.bar()

    def render_loop(self):
        """Capture and draw frames off the input thread; ~10 fps, idle when the page is still."""
        while not self.closing:
            started = time.perf_counter()
            self.frame()
            if DEBUG_LOG:
                with open(DEBUG_LOG, "a", encoding="utf-8") as f:
                    f.write(f"frame {1000 * (time.perf_counter() - started):.0f}ms\n")
            time.sleep(max(0.02, 0.1 - (time.perf_counter() - started)))


def flat(text):
    return re.sub(r"\s+", " ", str(text)).strip()


def main():
    start = (" ".join(sys.argv[1:]).strip() or os.environ.get("JEV_START_URL")
             or os.environ.get("JEV_HOME", "https://duckduckgo.com"))
    with term.RawTerminal() as t:
        browser = TerminalBrowser(t)
        try:
            browser.run(start)
        finally:
            browser.screen.reset()
            try:
                browser.tab.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
