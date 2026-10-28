"""Web server (Starlette). Run with: python -m app.main"""
import asyncio
import os
import sys

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import auth, config, db, updates
from . import discovery
from .discovery import registry

STATIC = os.path.join(os.path.dirname(__file__), "static")
PUBLIC = {"/", "/healthz", "/api/login", "/api/session", "/favicon.ico"}


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path in PUBLIC or path.startswith("/static/"):
            return await call_next(request)
        if not auth.valid_token(request.cookies.get(auth.COOKIE)):
            return JSONResponse({"error": "Not authenticated"}, status_code=401)
        # CSRF protection: a custom header cannot be sent from another origin without CORS
        if request.method != "GET" and request.headers.get("x-dbe") != "1":
            return JSONResponse({"error": "Request rejected"}, status_code=403)
        return await call_next(request)


def _err(exc: db.DBError) -> JSONResponse:
    return JSONResponse({"error": str(exc), "key": exc.key, "params": exc.params},
                        status_code=exc.status)


def _db_path(request: Request) -> str:
    entry = registry.get(request.path_params["db_id"])
    if entry is None:
        raise db.DBError("Database not found.", 404)
    return entry["fs_path"]


async def _body(request: Request) -> dict:
    try:
        data = await request.json()
    except ValueError:
        raise db.DBError("Invalid JSON.")
    if not isinstance(data, dict):
        raise db.DBError("Invalid JSON.")
    return data


def handler(fn):
    async def endpoint(request: Request):
        try:
            return JSONResponse(await fn(request))
        except db.DBError as exc:
            return _err(exc)
    return endpoint


# --------------------------------------------------------------------------- routes

async def index(request):
    return FileResponse(os.path.join(STATIC, "index.html"))


async def favicon(request):
    return FileResponse(os.path.join(STATIC, "icon.svg"), media_type="image/svg+xml")


async def healthz(request):
    return Response("ok")


async def login(request: Request):
    ip = request.client.host if request.client else "?"
    if auth.locked_out(ip):
        return JSONResponse({"error": "Too many attempts. Wait a few minutes."}, 429)
    try:
        password = str((await request.json()).get("password", ""))
    except (ValueError, AttributeError):
        password = ""
    if not auth.check_password(ip, password):
        await asyncio.sleep(1)
        return JSONResponse({"error": "Wrong password"}, status_code=401)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(auth.COOKIE, auth.make_token(), max_age=config.SESSION_HOURS * 3600,
                    httponly=True, samesite="strict")
    return resp


async def logout(request):
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE)
    return resp


async def session(request):
    return JSONResponse({
        "authenticated": auth.valid_token(request.cookies.get(auth.COOKIE)),
        "read_only": config.READ_ONLY, "sql_console": config.ENABLE_SQL_CONSOLE,
        "allow_schema_changes": config.ALLOW_SCHEMA_CHANGES,
    })


@handler
async def version(request: Request):
    return await run_in_threadpool(updates.status)


@handler
async def containers(request: Request):
    force = request.query_params.get("refresh") == "1"
    items = await run_in_threadpool(registry.containers, force)
    return {"containers": items, "error": registry.error,
            "host_root": discovery.host_root() is not None}


@handler
async def schema(request: Request):
    path = _db_path(request)
    data = await run_in_threadpool(db.get_schema, path)
    entry = registry.get(request.path_params["db_id"])
    data.update({"path": entry["path"], "containers": entry["containers"],
                 "mount_rw": entry.get("mount_rw", True),
                 "backups": await run_in_threadpool(db.list_backups, path)})
    return data


@handler
async def rows(request: Request):
    path = _db_path(request)
    qp = request.query_params
    table = qp.get("table")
    if not table:
        raise db.DBError("Missing table.")
    try:
        page, size = int(qp.get("page", 1)), int(qp.get("size", 50))
    except ValueError:
        raise db.DBError("Invalid pagination.")
    return await run_in_threadpool(db.read_rows, path, table, page, size, qp.get("sort") or None,
                                   qp.get("desc") == "1", qp.get("q") or None,
                                   qp.get("col") or None)


@handler
async def insert(request: Request):
    path, body = _db_path(request), await _body(request)
    return await run_in_threadpool(db.insert_row, path, str(body.get("table", "")),
                                   body.get("values") or {})


@handler
async def update(request: Request):
    path, body = _db_path(request), await _body(request)
    return await run_in_threadpool(db.update_row, path, str(body.get("table", "")),
                                   body.get("key"), body.get("values") or {})


@handler
async def delete(request: Request):
    path, body = _db_path(request), await _body(request)
    return await run_in_threadpool(db.delete_row, path, str(body.get("table", "")),
                                   body.get("key"))


@handler
async def backup(request: Request):
    path = _db_path(request)
    return await run_in_threadpool(db.make_backup, path)


@handler
async def sql(request: Request):
    path, body = _db_path(request), await _body(request)
    return await run_in_threadpool(db.run_sql, path, str(body.get("sql", "")),
                                   body.get("params") or [], bool(body.get("confirm")))


routes = [
    Route("/", index),
    Route("/favicon.ico", favicon),
    Route("/healthz", healthz),
    Route("/api/login", login, methods=["POST"]),
    Route("/api/logout", logout, methods=["POST"]),
    Route("/api/session", session),
    Route("/api/version", version),
    Route("/api/containers", containers),
    Route("/api/db/{db_id}", schema),
    Route("/api/db/{db_id}/rows", rows),
    Route("/api/db/{db_id}/insert", insert, methods=["POST"]),
    Route("/api/db/{db_id}/update", update, methods=["POST"]),
    Route("/api/db/{db_id}/delete", delete, methods=["POST"]),
    Route("/api/db/{db_id}/backup", backup, methods=["POST"]),
    Route("/api/db/{db_id}/sql", sql, methods=["POST"]),
    Mount("/static", StaticFiles(directory=STATIC), name="static"),
]

app = Starlette(routes=routes, middleware=[Middleware(AuthMiddleware)])


def main() -> None:
    import uvicorn

    if not config.PASSWORD:
        print("ERROR: set DB_EDITOR_PASSWORD; the UI has write access "
              "to every database.", file=sys.stderr)
        sys.exit(1)
    uvicorn.run(app, host="0.0.0.0", port=config.PORT, access_log=False, log_level="warning",
                server_header=False, proxy_headers=False)


if __name__ == "__main__":
    main()
