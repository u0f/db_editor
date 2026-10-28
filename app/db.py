"""Generic SQLite access: schema, paged reads, editing, backups and SQL console.

Rules that always hold:
  * never opened with immutable=1 (data still in the -wal would be lost);
  * reads use ``file:<path>?mode=ro``;
  * writes run in short, parametrized transactions (BEGIN IMMEDIATE ... COMMIT);
  * high busy_timeout, because another application may hold the single WAL writer slot;
  * never VACUUM or change journal_mode;
  * after writing, -wal/-shm keep the uid/gid of the main file.
"""
import base64
import math
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from urllib.parse import quote

from . import config


class DBError(Exception):
    def __init__(self, message: str, status: int = 400, **params):
        super().__init__(message.format(**params) if params else message)
        self.status = status
        self.key = message  # English template, used as the translation key by the UI
        self.params = params


MAX_SAFE_INT = 2**53 - 1
BLOB_PREVIEW = 4096
ROWID_ALIASES = ("rowid", "_rowid_", "oid")


def qi(name: str) -> str:
    """Quote an SQL identifier."""
    return '"' + name.replace('"', '""') + '"'


def affinity(decl_type: str | None) -> str:
    """Column affinity per SQLite rules (section 3.1 of datatype3)."""
    t = (decl_type or "").upper()
    if "INT" in t:
        return "INTEGER"
    if "CHAR" in t or "CLOB" in t or "TEXT" in t:
        return "TEXT"
    if t == "" or "BLOB" in t:
        return "BLOB"
    if "REAL" in t or "FLOA" in t or "DOUB" in t:
        return "REAL"
    return "NUMERIC"


# --------------------------------------------------------------------------- connection

def _deadline_handler(seconds: float):
    limit = time.monotonic() + seconds
    return lambda: 1 if time.monotonic() > limit else 0


def fix_ownership(path: str) -> None:
    """Make sure -wal/-shm/-journal have the same owner as the database."""
    try:
        st = os.stat(path)
    except OSError:
        return
    for suffix in ("-wal", "-shm", "-journal"):
        side = path + suffix
        try:
            s = os.stat(side)
            if (s.st_uid, s.st_gid) != (st.st_uid, st.st_gid):
                os.chown(side, st.st_uid, st.st_gid)
        except OSError:
            pass


@contextmanager
def connect(path: str, write: bool = False):
    mode = "rw" if write else "ro"
    try:
        conn = sqlite3.connect(f"file:{quote(path)}?mode={mode}", uri=True,
                               isolation_level=None, timeout=config.BUSY_TIMEOUT_MS / 1000)
    except sqlite3.Error as exc:
        raise DBError("Cannot open the database: {error}", 500, error=str(exc)) from exc
    try:
        conn.execute(f"PRAGMA busy_timeout = {int(config.BUSY_TIMEOUT_MS)}")
        deadline = config.WRITE_DEADLINE_S if write else config.READ_DEADLINE_S
        conn.set_progress_handler(_deadline_handler(deadline), 10000)
        yield conn
    finally:
        try:
            if conn.in_transaction:
                conn.rollback()
        finally:
            conn.close()
            if write:
                fix_ownership(path)


def _run(fn):
    """Translate SQLite errors into DBError with a readable message."""
    try:
        return fn()
    except sqlite3.OperationalError as exc:
        msg = str(exc)
        if "interrupted" in msg:
            raise DBError("The query took too long and was cancelled.", 408) from exc
        if "locked" in msg or "busy" in msg:
            raise DBError("The database is busy (another application is writing). "
                          "Try again.", 409) from exc
        raise DBError(msg) from exc
    except sqlite3.Error as exc:
        raise DBError(str(exc)) from exc


# --------------------------------------------------------------------------- values

def encode_value(v, full: bool = False):
    """SQLite value -> JSON that is safe for the browser."""
    if isinstance(v, bytes):
        data = v if full else v[:BLOB_PREVIEW]
        return {"$blob": base64.b64encode(data).decode(), "size": len(v),
                "truncated": len(data) < len(v)}
    if isinstance(v, int) and not isinstance(v, bool) and abs(v) > MAX_SAFE_INT:
        return {"$int": str(v)}
    if isinstance(v, float) and not math.isfinite(v):
        return {"$real": str(v)}
    return v


def decode_value(v):
    """Browser JSON -> value to bind in the query."""
    if isinstance(v, dict):
        if "$int" in v:
            return int(v["$int"])
        if "$real" in v:
            return float(v["$real"])
        if "$blob" in v:
            if v.get("truncated"):
                raise DBError("A truncated BLOB cannot be used.")
            return base64.b64decode(v["$blob"])
        raise DBError("Invalid value.")
    if isinstance(v, (list,)):
        raise DBError("Invalid value (use text for JSON).")
    return v


# --------------------------------------------------------------------------- schema

def _table_list(conn) -> dict[str, dict]:
    """Type of each object using PRAGMA table_list (3.37+) when available."""
    try:
        rows = conn.execute("PRAGMA main.table_list").fetchall()
    except sqlite3.Error:
        return {}
    return {r[1]: {"type": r[2], "without_rowid": bool(r[4])} for r in rows if r[0] == "main"}


def has_alembic(conn) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND "
                        "name='alembic_version'").fetchone() is not None


def _table_meta(conn, name: str, objects: dict | None = None, tlist: dict | None = None) -> dict:
    if objects is None:
        row = conn.execute("SELECT type, sql FROM sqlite_master WHERE name=? AND "
                           "type IN ('table','view')", (name,)).fetchone()
        if row is None:
            raise DBError("Table «{name}» does not exist.", 404, name=name)
        obj_type, sql = row
    else:
        obj_type, sql = objects[name]
    if tlist is None:
        tlist = _table_list(conn)
    info = tlist.get(name, {})
    kind = info.get("type") or obj_type
    sql_text = sql or ""
    if kind == "table" and sql_text.upper().lstrip().startswith("CREATE VIRTUAL"):
        kind = "virtual"
    without_rowid = info.get("without_rowid") or bool(
        re.search(r"\)\s*WITHOUT\s+ROWID\s*(,|;|$)", sql_text, re.I | re.S))

    error = None
    columns = []
    try:
        for cid, cname, ctype, notnull, default, pk in conn.execute(
                f"PRAGMA table_info({qi(name)})"):
            columns.append({"name": cname, "type": ctype or "", "affinity": affinity(ctype),
                            "notnull": bool(notnull), "default": default, "pk": pk})
    except sqlite3.Error as exc:  # e.g. virtual table whose module is unavailable
        error = str(exc)

    pk_cols = [c["name"] for c in sorted((c for c in columns if c["pk"]), key=lambda c: c["pk"])]
    col_names = {c["name"].lower() for c in columns}
    rowid = next((a for a in ROWID_ALIASES if a not in col_names), None)

    if pk_cols:
        key = {"kind": "pk", "columns": pk_cols}
    elif not without_rowid and kind in ("table",) and rowid:
        key = {"kind": "rowid", "columns": [rowid]}
    else:
        key = None

    readonly_reason = None
    if config.READ_ONLY:
        readonly_reason = "The viewer is in read-only mode (READ_ONLY)."
    elif kind == "view":
        readonly_reason = "It is a view."
    elif kind in ("virtual", "shadow"):
        readonly_reason = "Virtual table or internal table of a virtual table."
    elif name.startswith("sqlite_"):
        readonly_reason = "Internal SQLite table."
    elif name == "alembic_version":
        readonly_reason = "Alembic migration control table."
    elif key is None or error:
        readonly_reason = "There is no reliable way to identify the rows."

    return {"name": name, "type": kind, "sql": sql, "columns": columns, "key": key,
            "without_rowid": without_rowid, "editable": readonly_reason is None,
            "readonly_reason": readonly_reason, "error": error}


def get_schema(path: str) -> dict:
    def work():
        with connect(path) as conn:
            objects = {r[1]: (r[0], r[2]) for r in conn.execute(
                "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view') "
                "ORDER BY name COLLATE NOCASE")}
            tlist = _table_list(conn)
            tables = []
            for name in objects:
                meta = _table_meta(conn, name, objects, tlist)
                if meta["type"] != "view" and not meta["error"]:
                    meta["indexes"] = []
                    for _seq, iname, unique, origin, partial in conn.execute(
                            f"PRAGMA index_list({qi(name)})"):
                        cols = [r[2] for r in conn.execute(f"PRAGMA index_info({qi(iname)})")]
                        meta["indexes"].append({"name": iname, "unique": bool(unique),
                                                "origin": origin, "partial": bool(partial),
                                                "columns": cols})
                    meta["foreign_keys"] = [
                        {"id": r[0], "seq": r[1], "table": r[2], "from": r[3], "to": r[4],
                         "on_update": r[5], "on_delete": r[6]}
                        for r in conn.execute(f"PRAGMA foreign_key_list({qi(name)})")]
                tables.append(meta)
            journal = conn.execute("PRAGMA journal_mode").fetchone()[0]
            alembic = has_alembic(conn)
            version = None
            if alembic:
                try:
                    version = [r[0] for r in conn.execute(
                        "SELECT version_num FROM alembic_version")]
                except sqlite3.Error:
                    pass
            return {"tables": tables, "journal_mode": journal, "alembic": alembic,
                    "alembic_version": version, "sqlite_version": sqlite3.sqlite_version,
                    "schema_locked": schema_locked(alembic)}
    return _run(work)


def schema_locked(alembic: bool) -> bool:
    return alembic or not config.ALLOW_SCHEMA_CHANGES


# --------------------------------------------------------------------------- reading

def read_rows(path: str, table: str, page: int = 1, size: int = 50, sort: str | None = None,
              desc: bool = False, q: str | None = None, col: str | None = None) -> dict:
    size = max(1, min(int(size), config.MAX_PAGE_SIZE))
    page = max(1, int(page))

    def work():
        with connect(path) as conn:
            meta = _table_meta(conn, table)
            if meta["error"]:
                raise DBError(meta["error"])
            names = [c["name"] for c in meta["columns"]]
            key_cols = meta["key"]["columns"] if meta["key"] else []
            select = ", ".join([qi(k) for k in key_cols] + [qi(n) for n in names])
            sql = f"SELECT {select} FROM {qi(table)}"
            where, params = "", []
            if q:
                targets = [col] if col else names
                if col and col not in names:
                    raise DBError("Unknown filter column.")
                like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
                where = " WHERE (" + " OR ".join(
                    f"CAST({qi(t)} AS TEXT) LIKE ? ESCAPE '\\'" for t in targets) + ")"
                params = [like] * len(targets)
            order = ""
            if sort:
                if sort not in names and sort not in key_cols:
                    raise DBError("Unknown sort column.")
                direction = "DESC" if desc else "ASC"
                order = f" ORDER BY {qi(sort)} {direction}"
                tie = [k for k in key_cols if k != sort]
                if tie:
                    order += ", " + ", ".join(f"{qi(k)} {direction}" for k in tie)
            rows = conn.execute(f"{sql}{where}{order} LIMIT ? OFFSET ?",
                                params + [size, (page - 1) * size]).fetchall()
            nk = len(key_cols)
            out = [{"key": [encode_value(v, full=True) for v in r[:nk]],
                    "values": [encode_value(v) for v in r[nk:]]} for r in rows]
            try:
                total = conn.execute(f"SELECT count(*) FROM {qi(table)}{where}",
                                     params).fetchone()[0]
            except sqlite3.OperationalError:
                total = None  # huge table: the count is cancelled, the page is still served
            return {"table": meta, "rows": out, "page": page, "size": size, "total": total}
    return _run(work)


# --------------------------------------------------------------------------- writing

def _writable_meta(conn, table: str) -> dict:
    meta = _table_meta(conn, table)
    if not meta["editable"]:
        raise DBError("Table cannot be edited: {reason}", 403, reason=meta["readonly_reason"])
    return meta


def _key_where(meta: dict, key: list) -> tuple[str, list]:
    cols = meta["key"]["columns"]
    if not isinstance(key, list) or len(key) != len(cols):
        raise DBError("Invalid row key.")
    # IS instead of = : in rowid tables a PK can contain NULL
    return " AND ".join(f"{qi(c)} IS ?" for c in cols), [decode_value(v) for v in key]


def _check_columns(meta: dict, values: dict) -> list[str]:
    names = {c["name"] for c in meta["columns"]}
    if not isinstance(values, dict):
        raise DBError("Invalid values.")
    unknown = [k for k in values if k not in names]
    if unknown:
        raise DBError("Unknown columns: {columns}", columns=", ".join(unknown))
    return list(values)


def _write(path: str, fn):
    if config.READ_ONLY:
        raise DBError("The viewer is in read-only mode.", 403)

    def work():
        with connect(path, write=True) as conn:
            conn.execute("BEGIN IMMEDIATE")
            result = fn(conn)
            conn.execute("COMMIT")
            return result
    return _run(work)


def update_row(path: str, table: str, key: list, values: dict) -> dict:
    def fn(conn):
        meta = _writable_meta(conn, table)
        cols = _check_columns(meta, values)
        if not cols:
            return {"changes": 0}
        where, wparams = _key_where(meta, key)
        sets = ", ".join(f"{qi(c)} = ?" for c in cols)
        cur = conn.execute(f"UPDATE {qi(table)} SET {sets} WHERE {where}",
                           [decode_value(values[c]) for c in cols] + wparams)
        if cur.rowcount != 1:
            raise DBError("The edit would affect {count} rows; cancelled. "
                          "Did the row change or get deleted in the meantime?", 409,
                          count=cur.rowcount)
        return {"changes": 1}
    return _write(path, fn)


def insert_row(path: str, table: str, values: dict) -> dict:
    def fn(conn):
        meta = _writable_meta(conn, table)
        cols = _check_columns(meta, values)
        if cols:
            cur = conn.execute(
                f"INSERT INTO {qi(table)} ({', '.join(qi(c) for c in cols)}) "
                f"VALUES ({', '.join('?' for _ in cols)})",
                [decode_value(values[c]) for c in cols])
        else:
            cur = conn.execute(f"INSERT INTO {qi(table)} DEFAULT VALUES")
        return {"changes": 1, "rowid": encode_value(cur.lastrowid)}
    return _write(path, fn)


def delete_row(path: str, table: str, key: list) -> dict:
    def fn(conn):
        meta = _writable_meta(conn, table)
        where, params = _key_where(meta, key)
        cur = conn.execute(f"DELETE FROM {qi(table)} WHERE {where}", params)
        if cur.rowcount != 1:
            raise DBError("The delete would affect {count} rows; cancelled.", 409, count=cur.rowcount)
        return {"changes": 1}
    return _write(path, fn)


# --------------------------------------------------------------------------- backups

def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "db"


def _backup_dir(path: str) -> str:
    from .discovery import db_id
    return os.path.join(config.BACKUP_DIR, f"{_safe(os.path.basename(path))}-{db_id(path)[:8]}")


def make_backup(path: str) -> dict:
    """Consistent copy via the SQLite backup API (includes what is in the -wal)."""
    folder = _backup_dir(path)
    os.makedirs(folder, exist_ok=True)
    base, ext = os.path.splitext(os.path.basename(path))
    dest = os.path.join(folder, f"{base}-{datetime.now():%Y%m%d-%H%M%S}{ext or '.db'}")

    def work():
        with connect(path) as src:
            src.set_progress_handler(None, 0)  # a large copy must not be cut off
            dst = sqlite3.connect(dest)
            try:
                src.backup(dst)
            finally:
                dst.close()
    try:
        _run(work)
    except DBError:
        for leftover in (dest, dest + "-wal", dest + "-shm", dest + "-journal"):
            try:
                os.remove(leftover)
            except OSError:
                pass
        raise
    st = os.stat(path)
    for f in (dest, dest + "-wal", dest + "-shm"):
        try:
            os.chown(f, st.st_uid, st.st_gid)
        except OSError:
            pass
    _prune(folder)
    return {"file": dest, "size": os.path.getsize(dest)}


def _prune(folder: str) -> None:
    files = sorted((f for f in os.listdir(folder) if not f.endswith(("-wal", "-shm", "-journal"))),
                   reverse=True)
    for old in files[max(config.BACKUP_KEEP, 1):]:
        try:
            os.remove(os.path.join(folder, old))
        except OSError:
            pass


def list_backups(path: str) -> list[dict]:
    folder = _backup_dir(path)
    try:
        names = sorted(os.listdir(folder), reverse=True)
    except OSError:
        return []
    out = []
    for n in names:
        full = os.path.join(folder, n)
        if os.path.isfile(full) and not n.endswith(("-wal", "-shm", "-journal")):
            st = os.stat(full)
            out.append({"file": full, "name": n, "size": st.st_size, "mtime": int(st.st_mtime)})
    return out


# --------------------------------------------------------------------------- SQL console

_A = sqlite3
DDL_ACTIONS = {
    _A.SQLITE_CREATE_INDEX, _A.SQLITE_CREATE_TABLE, _A.SQLITE_CREATE_TEMP_INDEX,
    _A.SQLITE_CREATE_TEMP_TABLE, _A.SQLITE_CREATE_TEMP_TRIGGER, _A.SQLITE_CREATE_TEMP_VIEW,
    _A.SQLITE_CREATE_TRIGGER, _A.SQLITE_CREATE_VIEW, _A.SQLITE_DROP_INDEX, _A.SQLITE_DROP_TABLE,
    _A.SQLITE_DROP_TEMP_INDEX, _A.SQLITE_DROP_TEMP_TABLE, _A.SQLITE_DROP_TEMP_TRIGGER,
    _A.SQLITE_DROP_TEMP_VIEW, _A.SQLITE_DROP_TRIGGER, _A.SQLITE_DROP_VIEW, _A.SQLITE_ALTER_TABLE,
    _A.SQLITE_CREATE_VTABLE, _A.SQLITE_DROP_VTABLE, _A.SQLITE_REINDEX, _A.SQLITE_ANALYZE,
}
WRITE_ACTIONS = {_A.SQLITE_INSERT, _A.SQLITE_UPDATE, _A.SQLITE_DELETE}
ALWAYS_DENY = {_A.SQLITE_ATTACH, _A.SQLITE_DETACH, _A.SQLITE_TRANSACTION, _A.SQLITE_SAVEPOINT}
# read-only PRAGMAs that accept an argument (table/index name)
PRAGMA_WITH_ARG = {"table_info", "table_xinfo", "index_list", "index_info", "index_xinfo",
                   "foreign_key_list", "foreign_key_check", "integrity_check", "quick_check"}
PRAGMA_DENY = {"journal_mode", "writable_schema", "wal_checkpoint", "optimize",
               "incremental_vacuum", "shrink_memory", "locking_mode"}


def _strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return re.sub(r"--[^\n]*", " ", sql)


class _Guard:
    """SQLite authorizer: decides what a console statement may do.

    In probe mode (``probe``) it only records whether the statement writes or changes the
    structure; it runs on a ``mode=ro`` connection, so nothing reaches the file.
    """

    def __init__(self, probe: bool, allow_ddl: bool = False):
        self.probe = probe
        self.allow_ddl = allow_ddl
        self.wants_write = False
        self.wants_ddl = False
        self.internal = False
        self.denied: str | None = None

    def _deny(self, msg: str):
        self.denied = msg
        return sqlite3.SQLITE_DENY

    def __call__(self, action, arg1, arg2, dbname, source):
        if action in ALWAYS_DENY:
            return self._deny("Transactions, ATTACH and SAVEPOINT are not allowed.")
        if action == sqlite3.SQLITE_PRAGMA:
            name = (arg1 or "").lower()
            if name in PRAGMA_DENY or (arg2 is not None and name not in PRAGMA_WITH_ARG):
                return self._deny("This PRAGMA is not allowed here.")
            return sqlite3.SQLITE_OK
        if action in DDL_ACTIONS:
            self.wants_ddl = True
            if not self.probe and not self.allow_ddl:
                return self._deny("Changing the database structure is blocked.")
        elif action in WRITE_ACTIONS:
            self.wants_write = True
            # DDL statements write to sqlite_master; nothing else may touch it
            name = (arg1 or "").lower()
            if name.startswith("sqlite_") and name != "sqlite_sequence":
                self.internal = True
                if not self.probe and not self.allow_ddl:
                    return self._deny("Internal SQLite tables cannot be modified.")
        return sqlite3.SQLITE_OK


def run_sql(path: str, sql: str, params: list | None = None, confirm: bool = False) -> dict:
    if not config.ENABLE_SQL_CONSOLE:
        raise DBError("The SQL console is disabled.", 403)
    sql = (sql or "").strip()
    if not sql:
        raise DBError("Enter an SQL statement.")
    if re.match(r"\s*VACUUM\b", _strip_comments(sql), re.I):
        raise DBError("VACUUM is not allowed.", 403)
    params = [decode_value(p) for p in (params or [])]

    def execute(conn, guard):
        conn.execute("BEGIN" if guard.probe else "BEGIN IMMEDIATE")
        conn.set_authorizer(guard)
        try:
            cur = conn.execute(sql, params)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = cur.fetchmany(config.MAX_CONSOLE_ROWS + 1) if cols else []
        except sqlite3.DatabaseError as exc:
            if guard.denied:
                raise DBError(guard.denied, 403) from exc
            raise
        finally:
            conn.set_authorizer(None)
        changes = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        return {"columns": cols, "rows": [[encode_value(v) for v in r]
                                          for r in rows[:config.MAX_CONSOLE_ROWS]],
                "truncated": len(rows) > config.MAX_CONSOLE_ROWS, "changes": changes}

    def probe():
        with connect(path) as conn:
            alembic = has_alembic(conn)
            guard = _Guard(probe=True)
            try:
                result = execute(conn, guard)
            except (sqlite3.DatabaseError, DBError):
                if guard.denied or not (guard.wants_write or guard.wants_ddl):
                    raise
                result = None
            if guard.wants_write or guard.wants_ddl:
                result = None
            return alembic, guard, result

    alembic, guard, result = _run(probe)
    if result is not None:
        return {**result, "wrote": False}
    if guard.internal and not guard.wants_ddl:
        raise DBError("Internal SQLite tables cannot be modified.", 403)
    if guard.wants_ddl and schema_locked(alembic):
        if alembic:
            raise DBError("Changing the schema is blocked (the database uses Alembic migrations).", 403)
        raise DBError("Changing the schema is blocked (enable ALLOW_SCHEMA_CHANGES to allow it).", 403)
    if config.READ_ONLY:
        raise DBError("The viewer is in read-only mode.", 403)
    if not confirm:
        return {"needs_confirm": True, "ddl": guard.wants_ddl}

    def write():
        with connect(path, write=True) as conn:
            g = _Guard(probe=False, allow_ddl=not schema_locked(has_alembic(conn)))
            res = execute(conn, g)
            conn.execute("COMMIT")
            return res
    return {**_run(write), "wrote": True}
