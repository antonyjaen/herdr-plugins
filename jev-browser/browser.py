# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "jev-ultrafast @ git+https://github.com/browser-use/jev-ultrafast@1231850a0bf1a0c0341fe408ef1668dbbfdfac46",
#   "pillow>=11,<13",
# ]
# ///
"""A browser in a herdr pane: a dedicated Chrome, shown as truecolor text, driven by
hand (URL / element number) or by a goal that TypeSafe Jev + a small LLM carry out."""

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
         f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check", HOME_URL],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        if cdp_alive(port):
            marker.write_text(str(port))
            return port
        time.sleep(0.1)
    sys.exit("Chrome did not open its debugging port. If the jev-browser Chrome window is open, close it and retry.")


load_env()
os.environ["BU_CDP_URL"] = f"http://127.0.0.1:{ensure_chrome()}"
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


def halfblocks(jpeg_b64, cols, rows):
    """Render a screenshot as ▀ cells: fg = upper pixel, bg = lower pixel (24-bit SGR)."""
    img = Image.open(io.BytesIO(base64.b64decode(jpeg_b64))).convert("RGB")
    w = max(10, cols)
    h = max(2, min(rows * 2, round(img.height * w / img.width)))
    img = img.resize((w, h - h % 2), Image.Resampling.BILINEAR)
    px = img.load()
    lines = []
    for y in range(0, img.height, 2):
        cells = []
        for x in range(img.width):
            (r1, g1, b1), (r2, g2, b2) = px[x, y], px[x, y + 1]
            cells.append(f"\x1b[38;2;{r1};{g1};{b1}m\x1b[48;2;{r2};{g2};{b2}m▀")
        lines.append("".join(cells) + RESET)
    return "\n".join(lines)


def flat(text):
    return re.sub(r"\s+", " ", str(text)).strip()


class Session:
    def __init__(self):
        self.browser = Browser(HOME_URL)
        self.front()
        self.page = None
        self.show_shot = True
        self.show_text = False
        self.note = ""

    def front(self):
        """jev-ultrafast opens tabs in the background; screenshots of a hidden tab can hang."""
        cdp("Target.activateTarget", targetId=self.browser.target)

    def observe(self):
        self.page = self.browser.observe(screenshot=self.show_shot)

    def navigate(self, url):
        if not re.match(r"^[a-z][a-z0-9+.-]*:", url):
            url = "https://" + url
        self.browser.call("Page.navigate", url=url)
        self.settle()

    def settle(self):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if self.browser.evaluate("document.readyState") == "complete":
                    break
            except StalePage:
                pass
            time.sleep(0.05)
        self.observe()

    def element(self, n):
        action = next((a for a in self.page["actions"] if a.get("id") == f"e{n}"), None)
        if not action:
            raise ValueError(f"No element [{n}] on this page")
        return action

    def press_enter(self):
        for kind in ("keyDown", "keyUp"):
            self.browser.call("Input.dispatchKeyEvent", type=kind, key="Enter", code="Enter",
                              windowsVirtualKeyCode=13, **({"text": "\r"} if kind == "keyDown" else {}))
        self.wait_change(self.page["fingerprint"])

    def act(self, action, text=None):
        self.browser.act(action, self.page, text=text)
        self.wait_change(self.page["fingerprint"])

    def wait_change(self, before):
        # A click may start a navigation a moment later; wait briefly for the page to change.
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            time.sleep(0.1)
            try:
                if not self.browser.fresh(self.page):
                    break
            except StalePage:
                break
        self.settle()
        if self.page["fingerprint"] == before:
            self.note = "The page didn't change."

    def scroll(self, direction):
        action = next((a for a in self.page["actions"] if a["id"] == f"scroll_{direction}"), None)
        if not action:
            raise ValueError(f"Can't scroll {direction}")
        self.act(action)

    def run_goal(self, goal):
        """Hand the goal to Jev in a fresh tab at the current URL; adopt that tab afterwards."""
        if not os.environ.get("TYPESAFE_API_KEY"):
            raise ValueError("TYPESAFE_API_KEY is not set (environment or the plugin's .env).")
        url = self.page["url"] if self.page and self.page["url"] != HOME_URL else "https://www.google.com"
        agent = Agent(url, goal)
        cdp("Target.activateTarget", targetId=agent.browser.target)  # let the user watch it in Chrome
        print(f"\n{BOLD}Goal:{RESET} {goal}  {DIM}(Ctrl+C to stop){RESET}")
        status, detail = "stopped", ""
        try:
            for state in agent.run():
                status = state["status"]
                if state["history"]:
                    h = state["history"][-1]
                    typed = f' = "{h["text"]}"' if h.get("text") else ""
                    print(f"  {h['step']:>2}. {h['kind']:<6} {h['action'][:70]}{typed}  "
                          f"{DIM}p={h['probability']:.2f} {h['elapsed_ms']}ms{RESET}")
        except KeyboardInterrupt:
            print("  stopped by you")
        except Exception as err:  # model/provider/browser errors end the run, not the session
            status, detail = "error", f" — {type(err).__name__}: {err}"
        old, self.browser = self.browser, agent.browser
        old.close()
        self.front()
        steps = [f"{h['step']}. {h['kind']} {h['action'][:40]}" for h in agent.state["history"][-5:]]
        self.note = (f"Goal finished: {status} in {agent.state['elapsed_ms']} ms, "
                     f"{len(agent.state['history'])} actions{detail}" + "".join(f"\n  {s}" for s in steps))
        self.observe()

    def render(self):
        cols, rows = shutil.get_terminal_size((100, 40))
        p = self.page
        out = ["\x1b[2J\x1b[H", f"{BOLD}{flat(p['title'])[:cols - 2] or '(untitled)'}{RESET}", f"{DIM}{p['url'][:cols]}{RESET}"]
        elements = [a for a in p["actions"] if a["id"].startswith("e")]
        if self.show_shot and p.get("screenshot"):
            out.append(halfblocks(p["screenshot"], cols, max(6, rows - 14)))
        if self.show_text:
            out.append(re.sub(r"\s+", " ", p["text"])[: cols * 8])
        out.append("")
        note = [line[:cols] for line in self.note.splitlines()]
        # Every line below is one row: labels are flattened and cut to the pane width.
        budget = max(3, rows - len("\n".join(out).splitlines()) - len(note) - 3)
        shown = elements[:budget] if len(elements) <= budget else elements[: budget - 1]
        for a in shown:
            value = f" = {flat(a['value'])}" if a.get("value") else ""
            out.append(f"[{a['id'][1:]:>3}] {a['kind']:<6} {flat(a['label'])}{value[:30]}"[:cols])
        if len(shown) < len(elements):
            out.append(f"{DIM}... {len(elements) - len(shown)} more (hide the image with 'shot'){RESET}")
        out += [f"{DIM}{line}{RESET}" for line in note]
        out.append(f"{DIM}{'url | n=click | type n text | enter | up/down | back | reload | shot | text | do <goal> | q'[:cols]}{RESET}")
        print("\n".join(out))


HELP_URL = re.compile(r"^([a-z][a-z0-9+.-]*://\S+|[\w-]+(\.[\w-]+)+(/\S*)?)$", re.I)


def handle(s, line):
    s.note = ""
    if HELP_URL.match(line):
        return s.navigate(line)
    cmd, _, rest = line.partition(" ")
    cmd = cmd.lower()
    if cmd.isdigit():
        return s.act(s.element(int(cmd)))
    if cmd in {"go", "open"}:
        return s.navigate(rest.strip())
    if cmd == "type":
        n, _, text = rest.strip().partition(" ")
        action = s.element(int(n))
        if action["kind"] != "fill":
            raise ValueError(f"[{n}] is not a text field")
        return s.act(action, text=text)
    if cmd == "enter":
        return s.press_enter()
    if cmd in {"up", "down"}:
        return s.scroll(cmd)
    if cmd == "back":
        s.browser.evaluate("history.back()")
        time.sleep(0.3)
        return s.settle()
    if cmd == "reload":
        s.browser.call("Page.reload")
        time.sleep(0.3)
        return s.settle()
    if cmd == "shot":
        s.show_shot = not s.show_shot
        return s.observe()
    if cmd == "text":
        s.show_text = not s.show_text
        return None
    if cmd in {"do", "?"}:
        return s.run_goal(rest.strip())
    return s.run_goal(line)  # anything else is a goal


def main():
    s = Session()
    start = " ".join(sys.argv[1:]).strip() or os.environ.get("JEV_START_URL", "")
    if start:
        s.navigate(start)
    else:
        s.observe()
    while True:
        s.render()
        try:
            line = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if line.lower() in {"q", "quit", "exit"}:
            break
        if not line:
            s.observe()
            continue
        try:
            handle(s, line)
        except KeyboardInterrupt:
            s.note = "interrupted"
        except Exception as err:
            s.note = str(err)
            try:
                s.observe()
            except Exception:
                pass
    s.browser.close()


if __name__ == "__main__":
    main()
