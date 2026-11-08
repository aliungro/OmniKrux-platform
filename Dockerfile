# syntax=docker/dockerfile:1
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/ ./
RUN uv sync --frozen --no-dev --no-editable
COPY --from=frontend /frontend/dist /app/static

RUN useradd --uid 10001 --no-create-home --home-dir /app omnikrux \
    && mkdir /data && chown omnikrux:omnikrux /data
USER omnikrux

ENV PATH="/app/.venv/bin:$PATH" \
    OMNIKRUX_IN_CONTAINER=1 \
    OMNIKRUX_DATA_DIR=/data \
    OMNIKRUX_STATIC_DIR=/app/static
VOLUME /data
EXPOSE 8080 30000-30019
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health')"]
CMD ["uvicorn", "omnikrux.main:app", "--host", "0.0.0.0", "--port", "8080"]
