# AGENTS.md

- Stack: FastAPI (`server.py`, `backend/`), React + Vite (`web/src/`), Remotion (`remotion/`).
- UI: Teenage Engineering industrial style (`data-theme` light/dark).
- Rules:
  - No comments in code unless explicitly asked.
  - No hardcoded absolute paths; always resolve via `BASE_DIR` / `BASE_PATH`.
  - Keep `RUNTIME_SONG_FIELDS` stripped and writes atomic in `backend/schema.py`.
  - Never mutate real `playlist.json`, `raw/`, `processed/`, or `covers/` in tests.
- Commands:
  - Frontend build: `npm --prefix web run build`
  - Run: `.venv/bin/python server.py`
  - Test: `.venv/bin/pytest -v -m "not slow"`
  - UI Shots: `MRV_SCREENSHOT_DIR=/tmp/mrv_shots .venv/bin/pytest -v tests/test_frontend_e2e.py`
  - Full: `.venv/bin/pytest -v`
