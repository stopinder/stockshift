# CSV/XLSX/digital PDF CPU worker. Build with services/worker as the Docker build context.
FROM ghcr.io/astral-sh/uv:0.12.23 AS uv
FROM python:3.11.14-slim-bookworm
COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project --python /usr/local/bin/python
COPY src ./src
RUN uv sync --locked --no-dev --python /usr/local/bin/python

RUN groupadd --gid 10001 worker && useradd --uid 10001 --gid worker --no-create-home worker
USER worker
ENV PATH="/app/.venv/bin:$PATH"
CMD ["stockshift-worker"]
