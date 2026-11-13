# syntax=docker/dockerfile:1.7
# One Dockerfile for every Python service; each service is its own image:
#   --build-arg SERVICE_PATH=services/analytics-service
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore
WORKDIR /srv

# Shared infrastructure helpers first (changes rarely -> cached layer).
COPY packages/pykit /opt/pykit
RUN --mount=type=cache,target=/root/.cache/pip pip install /opt/pykit

ARG SERVICE_PATH
COPY ${SERVICE_PATH}/requirements.txt ./requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

COPY ${SERVICE_PATH}/ ./

# Unit tests in the same image the service runs in:
#   docker build -f infrastructure/docker/python-service.Dockerfile --build-arg SERVICE_PATH=... --target unit-test .
FROM base AS unit-test
RUN --mount=type=cache,target=/root/.cache/pip pip install pytest==9.2.0 \
 && python -m pytest -q tests

FROM base AS runtime
RUN useradd --system --uid 10001 --no-create-home titan \
 && mkdir -p /lake && chown titan /lake
USER titan
ENV PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health/live', timeout=2).status == 200 else 1)"
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
