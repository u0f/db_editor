"""Update check: compares app/VERSION with the one on GitHub. It only reports, never updates."""
import os
import re
import time
import urllib.request

from . import config

with open(os.path.join(os.path.dirname(__file__), "VERSION"), encoding="utf-8") as f:
    VERSION = f.read().strip()

CHECK_EVERY = 6 * 3600  # seconds between checks (cached in memory)
_cache = {"at": 0.0, "latest": None}


def _parse(v: str | None) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v or ""))


def latest() -> str | None:
    if time.time() - _cache["at"] > CHECK_EVERY:
        _cache["at"] = time.time()
        url = f"https://raw.githubusercontent.com/{config.UPDATE_REPO}/HEAD/app/VERSION"
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                _cache["latest"] = resp.read(64).decode().strip()
        except (OSError, ValueError):
            pass  # offline or GitHub unreachable: keep the last known value
    return _cache["latest"]


def status() -> dict:
    info = {"current": VERSION, "latest": None, "update_available": False,
            "url": f"https://github.com/{config.UPDATE_REPO}"}
    if config.UPDATE_CHECK:
        info["latest"] = latest()
        info["update_available"] = _parse(info["latest"]) > _parse(VERSION)
    return info
