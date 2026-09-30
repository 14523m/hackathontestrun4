# HK CoolPath AI — one-image production build.
#
# Stage 1 builds the Vite/React web app from web/.
# Stage 2 installs the FastAPI backend and copies the web build to
# /web/dist — the path backend/app/config.py resolves as REPO_ROOT/web/dist —
# so a single process serves both the UI and the JSON API on one origin.
#
#   docker build -t hk-coolpath .
#   docker run -p 8000:8000 hk-coolpath
#   # open http://localhost:8000
#
# Runtime config (all optional, see .env.example):
#   DATA_MODE=demo|live  HKO_BASE_URL=...  PORT=8000

FROM node:20-slim AS web

WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim

WORKDIR /app
# Only the package lives in /app before the install: setuptools' flat-layout
# discovery rejects a second top-level directory next to app/.
COPY backend/pyproject.toml ./
COPY backend/app ./app
RUN pip install --no-cache-dir .

# Served by FastAPI's StaticFiles mount at "/" (see backend/app/main.py)
COPY --from=web /web/dist /web/dist

ENV PORT=8000
EXPOSE 8000

# Generate the deterministic demo datasets if missing, then serve.
CMD ["sh", "-c", "python -m app.data.generate_static_data && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
