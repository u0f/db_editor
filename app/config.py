"""Configuration read from environment variables."""
import os


def _bool(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    return val.strip().lower() in ("1", "true", "yes", "on", "si", "sí")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


PASSWORD = os.environ.get("DB_EDITOR_PASSWORD", "")
PORT = _int("DB_EDITOR_PORT", 8790)

DOCKER_SOCKET = os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
# Host root mounted inside the viewer (- /:/host). If present, all mount paths are
# read through it, so there is no need to mount each folder separately.
HOST_ROOT = os.environ.get("HOST_ROOT", "/host")

# Discovery
SCAN_MAX_DEPTH = _int("SCAN_MAX_DEPTH", 4)
SCAN_MAX_ENTRIES = _int("SCAN_MAX_ENTRIES", 20000)  # per mount
DISCOVERY_TTL = _int("DISCOVERY_TTL", 60)  # seconds of in-memory cache
EXCLUDE_CONTAINERS = {
    c.strip() for c in os.environ.get("EXCLUDE_CONTAINERS", "").split(",") if c.strip()
}

# SQLite
BUSY_TIMEOUT_MS = _int("BUSY_TIMEOUT_MS", 10000)
READ_DEADLINE_S = _int("READ_DEADLINE_S", 20)  # abort reads that take too long
WRITE_DEADLINE_S = _int("WRITE_DEADLINE_S", 10)
MAX_PAGE_SIZE = 500
MAX_CONSOLE_ROWS = _int("MAX_CONSOLE_ROWS", 1000)

# Writing
READ_ONLY = _bool("READ_ONLY", False)
ALLOW_SCHEMA_CHANGES = _bool("ALLOW_SCHEMA_CHANGES", False)
ENABLE_SQL_CONSOLE = _bool("ENABLE_SQL_CONSOLE", True)

# Backups
BACKUP_DIR = os.environ.get("BACKUP_DIR", "/backups")
BACKUP_KEEP = _int("BACKUP_KEEP", 5)  # copies kept per database

# Session
SESSION_HOURS = _int("SESSION_HOURS", 12)

# Updates: only checks GitHub and tells the user, it never updates anything
UPDATE_CHECK = _bool("UPDATE_CHECK", True)
UPDATE_REPO = os.environ.get("UPDATE_REPO", "u0f/db_editor")
