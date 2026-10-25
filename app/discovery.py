"""Descubre las bases de datos SQLite de los contenedores en marcha.

Uso como script:  python -m app.discovery
"""
import hashlib
import os
import socket
import stat
import threading
import time

from . import config, docker_api

DB_EXTENSIONS = (".db", ".sqlite", ".sqlite3")
SQLITE_HEADER = b"SQLite format 3\x00"
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", "proc", "sys", "dev"}
SKIP_SOURCES = {"/", "/proc", "/sys", "/dev", "/run", "/var/run", "/etc", "/usr", "/boot"}


def is_sqlite_file(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            return fh.read(16) == SQLITE_HEADER
    except OSError:
        return False


def db_id(path: str) -> str:
    return hashlib.sha1(path.encode()).hexdigest()[:16]


def _scan_dir(root: str) -> list[str]:
    found = []
    seen = 0
    root_depth = root.rstrip("/").count("/")
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        depth = dirpath.rstrip("/").count("/") - root_depth
        if depth >= config.SCAN_MAX_DEPTH:
            dirnames[:] = []
        else:
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            seen += 1
            if name.lower().endswith(DB_EXTENSIONS):
                full = os.path.join(dirpath, name)
                if os.path.isfile(full) and not os.path.islink(full) and is_sqlite_file(full):
                    found.append(full)
        if seen > config.SCAN_MAX_ENTRIES:
            break
    return found


def scan_source(source: str) -> list[str]:
    """Busca archivos SQLite válidos en una ruta (archivo o carpeta)."""
    try:
        st = os.stat(source)
    except OSError:
        return []
    if stat.S_ISREG(st.st_mode):
        if source.lower().endswith(DB_EXTENSIONS) and is_sqlite_file(source):
            return [source]
        return []
    if stat.S_ISDIR(st.st_mode):
        return _scan_dir(source)
    return []


def _file_info(path: str) -> dict:
    st = os.stat(path)
    try:
        wal = os.path.getsize(path + "-wal")
    except OSError:
        wal = None
    return {"size": st.st_size, "wal_size": wal, "uid": st.st_uid, "gid": st.st_gid,
            "mtime": int(st.st_mtime)}


def _is_self(container: dict) -> bool:
    host = socket.gethostname()
    return bool(host) and container.get("Id", "").startswith(host)


def host_root() -> str | None:
    root = config.HOST_ROOT
    if root and os.path.isdir(root) and os.listdir(root):
        return root
    return None


def resolve(source: str) -> str | None:
    """Ruta del host -> ruta accesible dentro del visor (o None si no se ve)."""
    root = host_root()
    path = os.path.join(root, source.lstrip("/")) if root else source
    return path if os.path.exists(path) else None


def _maybe_db_mount(source: str, fs_path: str | None) -> bool:
    """¿Puede este montaje contener una base de datos? (carpeta o archivo .db/.sqlite)."""
    if fs_path is not None:
        return os.path.isdir(fs_path) or source.lower().endswith(DB_EXTENSIONS)
    name = os.path.basename(source.rstrip("/"))
    ext = os.path.splitext(name)[1].lower()
    return not ext or ext in DB_EXTENSIONS


def _container_path(path: str, source: str, destination: str) -> str:
    rel = os.path.relpath(path, source)
    return destination if rel == "." else os.path.join(destination, rel)


class Registry:
    """Resultado del descubrimiento cacheado en memoria (nada se escribe a disco)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._at = 0.0
        self._containers: list[dict] = []
        self._dbs: dict[str, dict] = {}
        self.error: str | None = None

    def refresh(self, force: bool = False) -> None:
        with self._lock:
            if not force and time.monotonic() - self._at < config.DISCOVERY_TTL:
                return
            try:
                containers, dbs = discover()
                self.error = None
            except docker_api.DockerError as exc:
                containers, dbs = [], {}
                self.error = str(exc)
            self._containers, self._dbs, self._at = containers, dbs, time.monotonic()

    def containers(self, force: bool = False) -> list[dict]:
        self.refresh(force)
        return self._containers

    def get(self, ident: str) -> dict | None:
        self.refresh()
        db = self._dbs.get(ident)
        if db is None:  # puede ser un contenedor recién arrancado
            self.refresh(force=True)
            db = self._dbs.get(ident)
        return db


def discover() -> tuple[list[dict], dict[str, dict]]:
    containers = []
    dbs: dict[str, dict] = {}
    running = docker_api.running_containers()
    # las copias de seguridad no deben aparecer como bases de datos (tampoco vistas por /host)
    excluded = {os.path.realpath(config.BACKUP_DIR)}
    for c in filter(_is_self, running):
        for m in c.get("Mounts") or []:
            if m.get("Destination") == config.BACKUP_DIR and (r := resolve(m.get("Source", ""))):
                excluded.add(os.path.realpath(r))
    for c in running:
        name = (c.get("Names") or ["?"])[0].lstrip("/")
        if name in config.EXCLUDE_CONTAINERS or _is_self(c):
            continue
        mounts, databases = [], []
        for m in c.get("Mounts") or []:
            source = m.get("Source") or ""
            dest = m.get("Destination") or ""
            if (not source or source.rstrip("/") in SKIP_SOURCES or source.endswith(".sock")
                    or source.startswith(("/etc/", "/proc/", "/sys/", "/dev/"))):
                continue
            fs_source = resolve(source)
            if not _maybe_db_mount(source, fs_source):
                continue  # archivos sueltos (config, cookies, /etc/localtime...)
            mounts.append({"type": m.get("Type"), "name": m.get("Name"), "source": source,
                           "destination": dest, "rw": m.get("RW", True),
                           "accessible": fs_source is not None})
            if fs_source is None:
                continue
            for fs_path in scan_source(fs_source):
                real = os.path.realpath(fs_path)
                if any(real.startswith(x + os.sep) for x in excluded):
                    continue
                rel = os.path.relpath(fs_path, fs_source)
                path = source if rel == "." else os.path.join(source, rel)  # ruta en el host
                ident = db_id(path)
                try:
                    info = _file_info(fs_path)
                except OSError:
                    continue
                entry = dbs.setdefault(ident, {"id": ident, "path": path, "fs_path": fs_path,
                                               "containers": [],
                                               "mount_rw": m.get("RW", True), **info})
                if name not in entry["containers"]:
                    entry["containers"].append(name)
                databases.append({"id": ident, "path": path, "name": os.path.basename(path),
                                  "container_path": _container_path(path, source, dest),
                                  **info})
        containers.append({"id": c.get("Id", "")[:12], "name": name, "image": c.get("Image"),
                           "status": c.get("Status"), "mounts": mounts,
                           "databases": databases})
    containers.sort(key=lambda x: (not x["databases"], x["name"].lower()))
    return containers, dbs


registry = Registry()


def _main() -> None:
    containers, _ = discover()
    for c in containers:
        print(f"{c['name']}  ({c['image']})")
        for m in c["mounts"]:
            flag = "" if m["accessible"] else "   [NO ACCESIBLE desde el visor]"
            print(f"   montaje {m['source']} -> {m['destination']}{flag}")
        for d in c["databases"]:
            wal = f", wal {d['wal_size']} B" if d["wal_size"] is not None else ""
            print(f"   * {d['path']}  ({d['size']} B{wal}, uid {d['uid']})  "
                  f"[en el contenedor: {d['container_path']}]")
        if not c["databases"]:
            print("   (sin bases de datos SQLite)")


if __name__ == "__main__":
    _main()
