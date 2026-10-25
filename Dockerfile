# Imagen multi-arch (arm64 / amd64): las bases oficiales de Python ya son multiplataforma.
#   docker buildx build --platform linux/arm64,linux/amd64 -t db-editor .
FROM python:3.13-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /opt/db-editor
COPY requirements.txt .
RUN apk add --no-cache tzdata && pip install -r requirements.txt
COPY app ./app

# Corre como root a propósito: necesita leer/escribir bases de datos de otros uid
# (p. ej. 10001) y devolver -wal/-shm a su dueño con chown. En el compose se le
# quitan todas las capabilities salvo CHOWN, DAC_OVERRIDE y FOWNER.
EXPOSE 8790
HEALTHCHECK --interval=2m --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:%s/healthz'%os.environ.get('DB_EDITOR_PORT','8790'),timeout=4)"
CMD ["python", "-m", "app.main"]
