# DB Editor

Visor/editor web de las bases de datos **SQLite** de los contenedores Docker en marcha,
ligero, para cualquier host con Docker (también Raspberry Pi y CasaOS).

- Descubre los contenedores en ejecución por `/var/run/docker.sock` y recorre sus `Mounts[]`.
- Encuentra `*.db`, `*.sqlite` y `*.sqlite3` y valida la cabecera `SQLite format 3\0`.
- Es genérico: lee el esquema en tiempo de ejecución (`sqlite_master`, `PRAGMA table_info`,
  `index_list`, `foreign_key_list`).
- Tablas paginadas, orden por columna, filtro de texto, formato legible de JSON, fechas ISO y epoch.
- Edición, inserción y borrado de filas, identificadas por clave primaria (simple o compuesta)
  o por `rowid`.
- Copia de seguridad con la API de backup de SQLite antes de escribir (se ofrece una vez por base
  de datos y sesión, y hay un botón para hacerla cuando quieras).
- Consola SQL opcional: una sentencia por ejecución y confirmación para las que escriben.

## Despliegue

1. Clona el repo en el host y crea el archivo `.env` con la contraseña (**obligatoria**):
   ```sh
   git clone https://github.com/u0f/db_editor.git && cd db_editor
   cp .env.example .env
   nano .env        # DB_EDITOR_PASSWORD=tu-contraseña
   chmod 600 .env
   ```
   `.env` está en `.gitignore`, así que la contraseña nunca se sube al repo. Sin ella,
   `docker compose` se niega a arrancar.
   - No hace falta listar las carpetas de tus proyectos: el compose monta la raíz del host en
     `/host` (`- /:/host:rslave`) y el visor traduce solo las rutas de cada montaje
     (`/home/user/projects/x/data` → `/host/home/user/projects/x/data`), incluidos los
     volúmenes con nombre de `/var/lib/docker/volumes`.
2. `docker compose up -d --build`
3. Abre `http://<ip-del-host>:8790` (o el icono en CasaOS, gracias al bloque `x-casaos`).
   Las copias de seguridad se guardan en `./backups`, junto al compose.

Puerto: **8790**.

Los contenedores sin bases de datos se agrupan al final, en «Sin bases de datos». Los montajes
que no pueden contener una base de datos (archivos sueltos como cookies, configuración o
`/etc/localtime`) no se tienen en cuenta. Si una carpeta montada no se ve desde el visor, aparece
con ⚠.

Para construir la imagen para ambas arquitecturas desde otro equipo:

```sh
docker buildx build --platform linux/arm64,linux/amd64 -t db-editor:latest .
```

### Variables de entorno

| Variable | Defecto | Descripción |
|---|---|---|
| `DB_EDITOR_PASSWORD` | — | Contraseña de la interfaz (obligatoria). |
| `TZ` | `UTC` | Zona horaria (en `.env`). |
| `DB_EDITOR_PORT` | `8790` | Puerto interno. |
| `READ_ONLY` | `false` | Desactiva cualquier escritura. |
| `ALLOW_SCHEMA_CHANGES` | `false` | Permite DDL (CREATE/DROP/ALTER) en la consola. Nunca en bases de datos con `alembic_version`. |
| `ENABLE_SQL_CONSOLE` | `true` | Muestra la consola SQL. |
| `BACKUP_DIR` | `/backups` | Dónde se guardan las copias. |
| `BACKUP_KEEP` | `5` | Copias que se conservan por base de datos. |
| `BUSY_TIMEOUT_MS` | `10000` | `PRAGMA busy_timeout` al escribir mientras otra aplicación escribe. |
| `HOST_ROOT` | `/host` | Dónde está montada la raíz del host. Si no existe, se usan las rutas tal cual (montándolas en la misma ruta). |
| `EXCLUDE_CONTAINERS` | — | Nombres separados por comas que no se escanean. |
| `SCAN_MAX_DEPTH` | `4` | Profundidad máxima al recorrer cada montaje. |
| `SESSION_HOURS` | `12` | Duración de la sesión. |

## Cómo trata las bases de datos

- **Lectura**: `file:<ruta>?mode=ro` sin `immutable=1`, así que se ven los datos que siguen en el `-wal`.
- **Escritura**: `PRAGMA busy_timeout` alto, `BEGIN IMMEDIATE` → una sentencia parametrizada →
  `COMMIT`. Si una edición o borrado no afecta exactamente a una fila, se deshace.
- Nunca hace `VACUUM` ni cambia `journal_mode` (también bloqueado en la consola, igual que
  `ATTACH`, transacciones manuales y `PRAGMA` que modifican).
- **Estructura**: bloqueada por defecto; en bases de datos con `alembic_version` siempre.
  La tabla `alembic_version`, las internas `sqlite_*`, las vistas y las tablas virtuales son de
  solo lectura.
- **Permisos**: el proceso es root dentro del contenedor (con solo `CHOWN`, `DAC_OVERRIDE` y
  `FOWNER`), así que puede escribir en archivos de cualquier uid sin tocar su dueño ni sus
  permisos. SQLite ya asigna al `-wal`/`-shm` que crea el uid/gid de la base de datos, y además
  el visor lo comprueba y corrige tras cada escritura. Las copias también se crean con el
  uid/gid del original.
- **Disco** (pensado también para tarjetas microSD): sin caché en disco ni logs de acceso; el
  descubrimiento se cachea en memoria
  (60 s), el sistema de archivos del contenedor es de solo lectura y solo se escribe en disco
  al editar o al hacer una copia.

## Desarrollo

```sh
pip install -r requirements.txt pytest
python -m pytest -q
python -m app.discovery          # lista contenedores y bases de datos encontradas
DB_EDITOR_PASSWORD=x python -m app.main
```
