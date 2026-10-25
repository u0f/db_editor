"""Configuración leída de variables de entorno."""
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

# Descubrimiento
SCAN_MAX_DEPTH = _int("SCAN_MAX_DEPTH", 4)
SCAN_MAX_ENTRIES = _int("SCAN_MAX_ENTRIES", 20000)  # por montaje
DISCOVERY_TTL = _int("DISCOVERY_TTL", 60)  # segundos de caché en memoria
EXCLUDE_CONTAINERS = {
    c.strip() for c in os.environ.get("EXCLUDE_CONTAINERS", "").split(",") if c.strip()
}

# SQLite
BUSY_TIMEOUT_MS = _int("BUSY_TIMEOUT_MS", 10000)
READ_DEADLINE_S = _int("READ_DEADLINE_S", 20)  # aborta lecturas demasiado largas
WRITE_DEADLINE_S = _int("WRITE_DEADLINE_S", 10)
MAX_PAGE_SIZE = 500
MAX_CONSOLE_ROWS = _int("MAX_CONSOLE_ROWS", 1000)

# Escritura
READ_ONLY = _bool("READ_ONLY", False)
ALLOW_SCHEMA_CHANGES = _bool("ALLOW_SCHEMA_CHANGES", False)
ENABLE_SQL_CONSOLE = _bool("ENABLE_SQL_CONSOLE", True)

# Copias de seguridad
BACKUP_DIR = os.environ.get("BACKUP_DIR", "/backups")
BACKUP_KEEP = _int("BACKUP_KEEP", 5)  # copias que se conservan por base de datos

# Sesión
SESSION_HOURS = _int("SESSION_HOURS", 12)
