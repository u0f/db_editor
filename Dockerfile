# Multi-arch image (arm64 / amd64): the official Python base images are already multi-platform.
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

# Runs as root on purpose: it must read/write databases owned by other uids
# (e.g. 10001) and give -wal/-shm back to their owner with chown. The compose file
# drops every capability except CHOWN, DAC_OVERRIDE and FOWNER.
EXPOSE 8790
HEALTHCHECK --interval=2m --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:%s/healthz'%os.environ.get('DB_EDITOR_PORT','8790'),timeout=4)"
CMD ["python", "-m", "app.main"]
