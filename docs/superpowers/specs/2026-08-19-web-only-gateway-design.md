# Web-only Memmy Gateway Design

## Goal

Provide a single local browser entry point for Memmy's React management UI, the Backend Local API, and the Memory service without Electron.

## Architecture

Docker Compose runs three services: `memory` (the existing Memory API), `agent-api` (the existing `App/backend` Local API with a fixed internal port), and `web` (the production React bundle served by Nginx). Nginx serves `/`, proxies `/api/v1/*` to `memory:18960`, and proxies the browser-facing Backend routes under `/api/*` plus `/api/events` to `agent-api:18100`. It injects the corresponding service token at the proxy boundary.

The Backend container uses the existing `createLocalBackend` lifecycle with a dedicated `serve-web` entrypoint. It stores app state under `/data`, reads `/config/config.yaml`, connects to `memory:18960`, and binds `0.0.0.0:18100`. The container does not start Electron, the Agent Gateway, or the model-serving CLI.

The public entry point is `http://127.0.0.1:19000/`. Memory remains available on `127.0.0.1:18960` for CLI and integration clients. Backend API is internal to the Compose network and is not published to the host.

## Scope

Included: overview, memory management, topic inbox, analysis, search, tasks, experiences, skills, project context, local API configuration, SSE events, and other frontend flows backed by the Backend Local API and Memory.

Excluded: desktop Agent Gateway bootstrapping, system tray, native notifications, native directory selection, Electron-only update/install actions, and the separate OpenAI-compatible `App/memmy-agent serve` endpoint.

## Security and persistence

The web service binds to `127.0.0.1` by default. Memory and Backend runtime tokens are supplied through the local root `.env`; neither token is included in static assets or `/__memmy_runtime_config`. `agent-api` receives the Memory token only as an environment variable and receives its own runtime token separately. `agent-api-data` persists the Backend SQLite state and `agent-api-config` persists the Memmy YAML configuration.

## Verification

Build all three images with Docker Compose, start the stack, verify `/`, `/__memmy_runtime_config`, `/api/v1/health`, `/api/health`, and `/api/app/bootstrap` through the public entry point. Exercise the browser Overview and Topic Inbox routes, then run the focused Memory topic-decision regression tests.
Build the web image with Docker Compose, start both services, verify `/`, `/__memmy_runtime_config`, and `/api/v1/health`, then exercise the browser UI through the overview and topic inbox routes. Run the focused Memory topic decision regression tests.
