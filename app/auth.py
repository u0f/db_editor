"""Autenticación por contraseña (variable de entorno) con cookie firmada en memoria."""
import hashlib
import hmac
import os
import time

from . import config

COOKIE = "dbe_session"
# Secreto aleatorio por arranque: reiniciar el contenedor cierra todas las sesiones.
_SECRET = os.urandom(32)
_failures: dict[str, list[float]] = {}
MAX_FAILURES = 10
LOCK_SECONDS = 300


def _sign(msg: str) -> str:
    return hmac.new(_SECRET, msg.encode(), hashlib.sha256).hexdigest()


def make_token() -> str:
    exp = str(int(time.time()) + config.SESSION_HOURS * 3600)
    return f"{exp}.{_sign(exp)}"


def valid_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    exp, sig = token.split(".", 1)
    if not hmac.compare_digest(sig, _sign(exp)):
        return False
    try:
        return int(exp) > time.time()
    except ValueError:
        return False


def locked_out(ip: str) -> bool:
    now = time.time()
    recent = [t for t in _failures.get(ip, []) if now - t < LOCK_SECONDS]
    _failures[ip] = recent
    return len(recent) >= MAX_FAILURES


def check_password(ip: str, password: str) -> bool:
    ok = hmac.compare_digest(password.encode(), config.PASSWORD.encode())
    if ok:
        _failures.pop(ip, None)
    else:
        _failures.setdefault(ip, []).append(time.time())
    return ok
