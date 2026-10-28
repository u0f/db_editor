# DB Editor

**English** · [Español](README.es.md)

Web viewer/editor for the **SQLite** databases of your running Docker containers. Lightweight
enough for any Docker host, including a Raspberry Pi or CasaOS.

- Discovers running containers through `/var/run/docker.sock` and walks their `Mounts[]`.
- Finds `*.db`, `*.sqlite` and `*.sqlite3` files and checks the `SQLite format 3\0` header.
- Generic: the schema is read at runtime (`sqlite_master`, `PRAGMA table_info`, `index_list`,
  `foreign_key_list`).
- Paginated tables, column sorting, text filter, readable JSON, ISO and epoch dates.
- Edit, insert and delete rows, identified by primary key (single or composite) or by `rowid`.
- Backups through the SQLite backup API before writing (offered once per database and session,
  plus a button to make one whenever you want).
- Optional SQL console: one statement per run, with confirmation for statements that write.
- UI in English, Spanish, Chinese, French, German and Portuguese (picked from the browser,
  switchable from the header).

## Deployment

1. Clone the repo on the host and create the `.env` file with the password (**required**):
   ```sh
   git clone https://github.com/u0f/db_editor.git && cd db_editor
   cp .env.example .env
   nano .env        # DB_EDITOR_PASSWORD=your-password
   chmod 600 .env
   ```
   `.env` is in `.gitignore`, so the password never ends up in the repo. Without it,
   `docker compose` refuses to start.
   - You don't need to list your project folders: the compose file mounts the host root at
     `/host` (`- /:/host:rslave`) and the viewer translates every mount path on its own
     (`/home/user/projects/x/data` → `/host/home/user/projects/x/data`), including named
     volumes under `/var/lib/docker/volumes`.
2. `docker compose up -d --build`
3. Open `http://<host-ip>:8790` (or the CasaOS icon, thanks to the `x-casaos` block).
   Backups are stored in `./backups`, next to the compose file.

Port: **8790**.

Containers without databases are grouped at the end, under "No databases". Mounts that cannot
hold a database (single files such as cookies, configuration or `/etc/localtime`) are ignored.
If a mounted folder is not visible to the viewer, it is shown with ⚠.

To build the image for both architectures from another machine:

```sh
docker buildx build --platform linux/arm64,linux/amd64 -t db-editor:latest .
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `DB_EDITOR_PASSWORD` | — | UI password (required). |
| `TZ` | `UTC` | Time zone (in `.env`). |
| `DB_EDITOR_PORT` | `8790` | Internal port. |
| `READ_ONLY` | `false` | Disables every write. |
| `ALLOW_SCHEMA_CHANGES` | `false` | Allows DDL (CREATE/DROP/ALTER) in the console. Never on databases with `alembic_version`. |
| `ENABLE_SQL_CONSOLE` | `true` | Shows the SQL console. |
| `BACKUP_DIR` | `/backups` | Where backups are stored. |
| `BACKUP_KEEP` | `5` | Backups kept per database. |
| `BUSY_TIMEOUT_MS` | `10000` | `PRAGMA busy_timeout` when writing while another application writes. |
| `HOST_ROOT` | `/host` | Where the host root is mounted. If it does not exist, paths are used as-is (mount them at the same path). |
| `EXCLUDE_CONTAINERS` | — | Comma-separated container names that are not scanned. |
| `SCAN_MAX_DEPTH` | `4` | Maximum depth when walking each mount. |
| `SESSION_HOURS` | `12` | Session length. |
| `UPDATE_CHECK` | `true` | Checks GitHub for a newer version (every 6 h) and shows a notice. It never updates anything. |
| `UPDATE_REPO` | `u0f/db_editor` | GitHub repository to check (change it if you use a fork). |

## How databases are handled

- **Reads**: `file:<path>?mode=ro` without `immutable=1`, so data still in the `-wal` is visible.
- **Writes**: high `PRAGMA busy_timeout`, `BEGIN IMMEDIATE` → one parameterized statement →
  `COMMIT`. If an edit or delete does not affect exactly one row, it is rolled back.
- Never runs `VACUUM` nor changes `journal_mode` (also blocked in the console, like `ATTACH`,
  manual transactions and `PRAGMA`s that modify).
- **Schema**: locked by default, and always on databases with `alembic_version`. The
  `alembic_version` table, the internal `sqlite_*` tables, views and virtual tables are
  read-only.
- **Permissions**: the process is root inside the container (with only `CHOWN`, `DAC_OVERRIDE`
  and `FOWNER`), so it can write files owned by any uid without changing their owner or mode.
  SQLite already gives the `-wal`/`-shm` files it creates the database's uid/gid, and the viewer
  also checks and fixes that after every write. Backups are created with the original's uid/gid
  too.
- **Disk** (also designed for microSD cards): no disk cache and no access logs; discovery is
  cached in memory (60 s), the container filesystem is read-only and the disk is only written
  when editing or making a backup.

## Updating

When a newer version is published on GitHub, an "Update available" button appears in the
header. The viewer never updates itself; to update, run this where you cloned the repo:

```sh
git pull
docker compose up -d --build
```

The check reads [`app/VERSION`](app/VERSION) from GitHub at most every 6 hours and can be turned
off with `UPDATE_CHECK=false`. To publish a new version, bump `app/VERSION` and push.

## Translations

UI strings are written in English in the code and that English text is also the translation
key. Translations live in [`app/static/i18n/<lang>.json`](app/static/i18n) as flat
`{"English text": "translation"}` objects; missing keys fall back to English. To add a
language, copy one of those files, translate the values (keep `{placeholders}` as they are)
and add the language code to `LANGS` in [`app/static/app.js`](app/static/app.js).

## Development

```sh
pip install -r requirements.txt pytest
python -m pytest -q
python -m app.discovery          # lists containers and the databases found
DB_EDITOR_PASSWORD=x python -m app.main
```

## License

[MIT](LICENSE)
