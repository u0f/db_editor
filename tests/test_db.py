import os
import sqlite3

import pytest

from app import config, db


@pytest.fixture
def dbfile(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BACKUP_DIR", str(tmp_path / "backups"))
    path = str(tmp_path / "bot.db")
    writer = sqlite3.connect(path, isolation_level=None)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("PRAGMA synchronous=NORMAL")
    writer.executescript("""
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, data TEXT,
                            created_at REAL, big INTEGER, active INTEGER DEFAULT 1);
        CREATE TABLE pairs (a TEXT, b INTEGER, v TEXT, PRIMARY KEY (a, b));
        CREATE TABLE logs (msg TEXT);
    """)
    writer.execute("INSERT INTO users (name, data, created_at, big) VALUES "
                   "('ana', '{\"x\": 1}', 1700000000.5, 1234567890123456789)")
    writer.execute("INSERT INTO pairs VALUES ('k', 1, 'uno'), ('k', 2, 'dos')")
    writer.execute("INSERT INTO logs VALUES ('hola'), ('hola')")
    # the "bot" keeps its connection open: the data stays in the -wal
    yield path, writer
    writer.close()


def test_reads_wal_data_and_schema(dbfile):
    path, _ = dbfile
    assert os.path.getsize(path + "-wal") > 0
    schema = db.get_schema(path)
    names = {t["name"]: t for t in schema["tables"]}
    assert schema["journal_mode"] == "wal"
    assert names["users"]["key"] == {"kind": "pk", "columns": ["id"]}
    assert names["pairs"]["key"]["columns"] == ["a", "b"]
    assert names["logs"]["key"]["kind"] == "rowid"
    assert not names["sqlite_sequence"]["editable"]
    rows = db.read_rows(path, "users")
    assert rows["total"] == 1
    assert rows["rows"][0]["values"][4] == {"$int": "1234567890123456789"}


def test_filter_sort_paging(dbfile):
    path, _ = dbfile
    r = db.read_rows(path, "pairs", sort="b", desc=True, size=1)
    assert r["total"] == 2 and r["rows"][0]["values"][2] == "dos"
    r = db.read_rows(path, "pairs", q="un", col="v")
    assert r["total"] == 1
    r = db.read_rows(path, "pairs", q="50%")
    assert r["total"] == 0
    with pytest.raises(db.DBError):
        db.read_rows(path, "pairs", sort="x; DROP TABLE pairs")


def test_edit_while_bot_connected(dbfile):
    path, writer = dbfile
    db.update_row(path, "users", [1], {"name": "Ana", "big": {"$int": "9223372036854775807"}})
    assert writer.execute("SELECT name, big FROM users").fetchone() == ("Ana", 2**63 - 1)
    db.update_row(path, "pairs", ["k", 2], {"v": "DOS"})
    assert writer.execute("SELECT v FROM pairs WHERE b=2").fetchone() == ("DOS",)
    res = db.insert_row(path, "users", {"name": "bob"})
    assert writer.execute("SELECT active FROM users WHERE id=?", (res["rowid"],)).fetchone() == (1,)
    rows = db.read_rows(path, "logs")["rows"]
    db.delete_row(path, "logs", rows[0]["key"])
    assert writer.execute("SELECT count(*) FROM logs").fetchone() == (1,)
    with pytest.raises(db.DBError):
        db.delete_row(path, "users", [999])
    with pytest.raises(db.DBError):
        db.update_row(path, "users", [1], {"nope": 1})
    assert writer.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_busy_writer_times_out_cleanly(dbfile, monkeypatch):
    path, writer = dbfile
    monkeypatch.setattr(config, "BUSY_TIMEOUT_MS", 200)
    writer.execute("BEGIN IMMEDIATE")
    try:
        with pytest.raises(db.DBError) as exc:
            db.update_row(path, "users", [1], {"name": "x"})
        assert exc.value.status == 409
    finally:
        writer.execute("ROLLBACK")


@pytest.mark.skipif(os.geteuid() != 0, reason="needs root for chown")
def test_ownership_preserved(dbfile):
    path, writer = dbfile
    writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    for f in (path, path + "-wal", path + "-shm"):
        os.chown(f, 10001, 10001)
    db.update_row(path, "users", [1], {"name": "z"})
    for f in (path, path + "-wal", path + "-shm"):
        if os.path.exists(f):
            assert (os.stat(f).st_uid, os.stat(f).st_gid) == (10001, 10001), f
    b = db.make_backup(path)
    assert os.stat(b["file"]).st_uid == 10001


def test_backup_includes_wal(dbfile):
    path, writer = dbfile
    writer.execute("INSERT INTO logs VALUES ('reciente')")
    b = db.make_backup(path)
    copy = sqlite3.connect(b["file"])
    assert copy.execute("SELECT count(*) FROM logs WHERE msg='reciente'").fetchone() == (1,)
    copy.close()
    assert len(db.list_backups(path)) == 1


def test_console(dbfile, monkeypatch):
    path, writer = dbfile
    r = db.run_sql(path, "SELECT name FROM users")
    assert r["rows"] == [["ana"]] and not r["wrote"]
    r = db.run_sql(path, "UPDATE users SET name='x'")
    assert r == {"needs_confirm": True, "ddl": False}
    assert writer.execute("SELECT name FROM users").fetchone() == ("ana",)
    r = db.run_sql(path, "UPDATE users SET name='x'", confirm=True)
    assert r["wrote"] and r["changes"] == 1
    for bad in ("DROP TABLE users", "ALTER TABLE users ADD COLUMN z", "VACUUM",
                "/* x */ vacuum into '/tmp/x.db'", "PRAGMA journal_mode=DELETE",
                "ATTACH '/tmp/x.db' AS x", "BEGIN", "DELETE FROM sqlite_master"):
        with pytest.raises(db.DBError):
            db.run_sql(path, bad, confirm=True)
    with pytest.raises(db.DBError):
        db.run_sql(path, "SELECT 1; DROP TABLE users", confirm=True)
    assert db.run_sql(path, "PRAGMA table_info(users)")["rows"]
    monkeypatch.setattr(config, "ALLOW_SCHEMA_CHANGES", True)
    assert db.run_sql(path, "CREATE INDEX ix ON users(name)", confirm=True)["wrote"]
    writer.execute("CREATE TABLE alembic_version (version_num TEXT)")
    with pytest.raises(db.DBError):
        db.run_sql(path, "DROP INDEX ix", confirm=True)
    assert writer.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_discovery_header_check(tmp_path):
    from app import discovery
    (tmp_path / "fake.db").write_bytes(b"not sqlite")
    real = tmp_path / "sub" / "real.sqlite3"
    real.parent.mkdir()
    sqlite3.connect(real).execute("CREATE TABLE t (x)").connection.close()
    assert discovery.scan_source(str(tmp_path)) == [str(real)]


def test_host_root_translation(tmp_path, monkeypatch):
    from app import discovery
    root = tmp_path / "host"
    data = root / "home" / "user" / "projects" / "app" / "data"
    data.mkdir(parents=True)
    sqlite3.connect(data / "app.db").execute("CREATE TABLE t (x)").connection.close()
    (root / "etc").mkdir()
    (root / "etc" / "localtime").write_text("tz")
    monkeypatch.setattr(config, "HOST_ROOT", str(root))
    monkeypatch.setattr(discovery.docker_api, "running_containers", lambda: [{
        "Id": "x", "Names": ["/my-app"], "Image": "app", "Mounts": [
            {"Type": "bind", "Source": "/home/user/projects/app/data", "Destination": "/data"},
            {"Type": "bind", "Source": "/etc/localtime", "Destination": "/etc/localtime"},
            {"Type": "bind", "Source": "/home/user/projects/x/cookies.txt", "Destination": "/c"},
            {"Type": "bind", "Source": "/home/user/projects/other/data", "Destination": "/data"},
        ]}])
    containers, dbs = discovery.discover()
    c = containers[0]
    assert [d["path"] for d in c["databases"]] == ["/home/user/projects/app/data/app.db"]
    assert c["databases"][0]["container_path"] == "/data/app.db"
    entry = dbs[c["databases"][0]["id"]]
    assert entry["fs_path"] == str(data / "app.db")
    # only the missing folder is flagged, not loose files
    assert [m["source"] for m in c["mounts"] if not m["accessible"]] == ["/home/user/projects/other/data"]
