"""Raw terminal I/O for Windows (console VT input via ctypes) and POSIX (termios),
plus a parser for the key and SGR-mouse sequences the browser needs."""

import os
import re
import sys
import threading
import queue

IS_WIN = sys.platform == "win32"

ENTER_UI = "\x1b[?1049h\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?2004h"  # alt screen, no cursor, mouse+drag, SGR, paste
LEAVE_UI = "\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?25h\x1b[?1049l"


class RawTerminal:
    """Context manager: raw, VT-input mode; read() yields decoded text chunks from a thread."""

    def __enter__(self):
        if IS_WIN:
            import ctypes
            from ctypes import wintypes

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            self._k32 = k32
            self._in = k32.GetStdHandle(-10)
            self._out = k32.GetStdHandle(-11)
            self._old_in, self._old_out = wintypes.DWORD(), wintypes.DWORD()
            k32.GetConsoleMode(self._in, ctypes.byref(self._old_in))
            k32.GetConsoleMode(self._out, ctypes.byref(self._old_out))
            ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_EXTENDED_FLAGS = 0x0200, 0x0080
            k32.SetConsoleMode(self._in, ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_EXTENDED_FLAGS)
            ENABLE_PROCESSED_OUTPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x1, 0x4
            k32.SetConsoleMode(self._out, ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING)
            try:
                sys.stdout.reconfigure(encoding="utf-8")
            except AttributeError:
                pass
        else:
            import termios
            import tty

            self._fd = sys.stdin.fileno()
            self._old = termios.tcgetattr(self._fd)
            tty.setraw(self._fd)
        self.events = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()
        write(ENTER_UI)
        return self

    def __exit__(self, *_):
        write(LEAVE_UI)
        if IS_WIN:
            self._k32.SetConsoleMode(self._in, self._old_in)
            self._k32.SetConsoleMode(self._out, self._old_out)
        else:
            import termios

            termios.tcsetattr(self._fd, termios.TCSADRAIN, self._old)

    def _reader(self):
        if IS_WIN:
            import ctypes
            from ctypes import wintypes

            buf = ctypes.create_unicode_buffer(4096)
            n = wintypes.DWORD()
            while self._k32.ReadConsoleW(self._in, buf, 4096, ctypes.byref(n), None):
                if n.value:
                    self.events.put(buf[: n.value])
        else:
            while True:
                data = os.read(self._fd, 4096)
                if not data:
                    break
                self.events.put(data.decode("utf-8", "replace"))


_write_lock = threading.Lock()


def write(text):
    with _write_lock:  # the frame thread and the input loop both draw
        sys.stdout.write(text)
        sys.stdout.flush()


def size():
    s = os.get_terminal_size() if sys.stdout.isatty() else os.terminal_size((100, 40))
    return s.columns, s.lines


# ── Input parsing ────────────────────────────────────────────────────────────────

MOUSE = re.compile(r"\x1b\[<(\d+);(\d+);(\d+)([Mm])")
CSI = re.compile(r"\x1b\[([0-9;]*)([~A-Za-z])")
SS3 = re.compile(r"\x1bO([A-Za-z])")
PASTE = re.compile(r"\x1b\[200~(.*?)\x1b\[201~", re.S)

CSI_KEYS = {"A": "up", "B": "down", "C": "right", "D": "left", "H": "home", "F": "end", "Z": "shift+tab"}
TILDE_KEYS = {"1": "home", "2": "insert", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end"}


def _mods(code):
    m = max(0, int(code) - 1) if code else 0
    return ("shift+" if m & 1 else "") + ("alt+" if m & 2 else "") + ("ctrl+" if m & 4 else "")


def parse(data):
    """Turn a chunk into events: ("mouse", button, x, y, pressed, mods), ("key", name), ("text", str), ("paste", str)."""
    out, i = [], 0
    while i < len(data):
        ch = data[i]
        if ch == "\x1b":
            if m := PASTE.match(data, i):
                out.append(("paste", m.group(1)))
                i = m.end()
                continue
            if m := MOUSE.match(data, i):
                b, x, y, kind = int(m.group(1)), int(m.group(2)) - 1, int(m.group(3)) - 1, m.group(4)
                mods = ("shift+" if b & 4 else "") + ("alt+" if b & 8 else "") + ("ctrl+" if b & 16 else "")
                if b & 64:
                    out.append(("wheel", -1 if b & 1 == 0 else 1, x, y, mods))
                else:
                    out.append(("mouse", b & 3, x, y, kind == "M", bool(b & 32), mods))
                i = m.end()
                continue
            if m := CSI.match(data, i):
                params, final = m.group(1).split(";"), m.group(2)
                if final == "~":
                    name = TILDE_KEYS.get(params[0])
                    if name:
                        out.append(("key", _mods(params[1] if len(params) > 1 else "") + name))
                elif final == "u" and params[0].isdigit():  # kitty keyboard / CSI-u
                    out.append(("key", _mods(params[1] if len(params) > 1 else "") + _char_name(int(params[0]))))
                elif final in CSI_KEYS:
                    out.append(("key", _mods(params[1] if len(params) > 1 else "") + CSI_KEYS[final]))
                i = m.end()
                continue
            if m := SS3.match(data, i):
                out.append(("key", CSI_KEYS.get(m.group(1), m.group(1).lower())))
                i = m.end()
                continue
            if i + 1 < len(data) and data[i + 1] not in "[O":
                nxt = data[i + 1]
                out.append(("key", "alt+" + (_ctrl_name(nxt) if ord(nxt) < 32 or nxt == "\x7f" else nxt)))
                i += 2
                continue
            out.append(("key", "esc"))
            i += 1
            continue
        if ord(ch) < 32 or ch == "\x7f":
            out.append(("key", _ctrl_name(ch)))
        else:
            j = i
            while j < len(data) and data[j] != "\x1b" and ord(data[j]) >= 32 and data[j] != "\x7f":
                j += 1
            out.append(("text", data[i:j]))
            i = j
            continue
        i += 1
    return out


def _ctrl_name(ch):
    return {"\r": "enter", "\n": "enter", "\t": "tab", "\x7f": "backspace", "\x08": "backspace",
            "\x1b": "esc"}.get(ch) or "ctrl+" + chr(ord(ch) + 96)


def _char_name(code):
    return {13: "enter", 9: "tab", 27: "esc", 127: "backspace"}.get(code, chr(code))
