"""Cliente mínimo de la API de Docker por socket Unix (sin dependencias)."""
import http.client
import json
import socket

from . import config


class DockerError(Exception):
    pass


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float = 5.0):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.socket_path)
        self.sock = sock


def _get(path: str):
    conn = _UnixHTTPConnection(config.DOCKER_SOCKET)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read()
    except OSError as exc:
        raise DockerError(f"No se puede hablar con Docker en {config.DOCKER_SOCKET}: {exc}") from exc
    finally:
        conn.close()
    if resp.status != 200:
        raise DockerError(f"Docker respondió {resp.status}: {body[:200]!r}")
    return json.loads(body)


def running_containers() -> list[dict]:
    """Contenedores en ejecución (incluye Mounts[] con Source/Destination)."""
    return _get("/containers/json")
