"""CAD Studio - local web server for verified exploded views.

    python -m studio.server --port 8780      (then open http://127.0.0.1:8780)

Catalogue: the built-in synthetic samples of ``exploded_view_verifier`` and every
``*.step`` / ``*.stp`` file under ``CAD_DATA_ROOT`` (default: ``./models``).
Each model is computed once by ``studio/worker.py`` in a separate process (one at a time);
results go to ``STUDIO_RUNTIME`` (default: ``./runtime``).

Exports: PNG snapshot (``POST /api/snapshot``) and a standalone HTML page
(``POST /api/share``) embedding three.js, the renderer, the geometry, the vectors, the
bill of materials and the verdicts.

The server listens on 127.0.0.1 only and makes no network or LLM call.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from .worker import write_json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WEB = HERE / "web"
DATA = Path(os.environ.get("CAD_DATA_ROOT", ROOT / "models"))
RUNTIME = Path(os.environ.get("STUDIO_RUNTIME", ROOT / "runtime"))
SOURCES = {"sample": "Built-in samples", "step": "Local STEP files"}
CATALOG: dict = {}
JOBS: dict = {}
LOCK = threading.RLock()
WORK: "queue.Queue[str]" = queue.Queue()
TIMEOUT = int(os.environ.get("STUDIO_TIMEOUT_S", "1800"))


def index_data():
    from exploded_view_verifier import samples
    entries = [("sample", name, "", "synthetic assembly") for name in samples.SAMPLES]
    if DATA.is_dir():
        entries += [("step", p.relative_to(DATA).as_posix(), str(p), "STEP assembly")
                    for p in DATA.rglob("*") if p.suffix.lower() in (".step", ".stp")]
    CATALOG.clear()
    for source, case, path, kind in sorted(entries):
        uid = hashlib.sha256((source + ":" + case).encode()).hexdigest()[:20]
        CATALOG[uid] = dict(id=uid, source=source, case=case, path=path, kind=kind)


def status(uid):
    folder = RUNTIME / uid
    try:
        value = json.loads((folder / "status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        value = {"state": "new", "message": "Ready to load", "progress": 0}
    value["scene_ready"] = (folder / "scene.json").exists()
    if uid in JOBS:
        value["started"] = JOBS[uid].get("started")
        if JOBS[uid].get("queued"):
            value.update(state="queued", message="Waiting for the previous computation")
    return value


def runner():
    while True:
        uid = WORK.get()
        folder = RUNTIME / uid
        with LOCK:
            job = JOBS.get(uid)
            if not job or job.get("cancelled"):
                WORK.task_done()
                continue
            job.update(queued=False, started=time.time())
        with open(folder / "worker.log", "w", encoding="utf-8") as log:
            proc = subprocess.Popen(
                [sys.executable, "-B", "-m", "studio.worker", "--request", str(folder / "request.json")],
                stdout=log, stderr=log, cwd=str(ROOT),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONHASHSEED": "0"})
            with LOCK:
                job["proc"] = proc
                if job.get("cancelled"):
                    proc.terminate()
            try:
                code = proc.wait(timeout=TIMEOUT)
                if job.get("cancelled"):
                    write_json(folder / "status.json", dict(state="cancelled", progress=0,
                                                            message="Computation stopped. Assembled view available."))
                elif code != 0 and status(uid)["state"] != "error":
                    write_json(folder / "status.json", dict(state="error", progress=0,
                                                            message="The geometric computation failed. No verified view."))
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                write_json(folder / "status.json", dict(state="timeout", progress=0,
                                                        message=f"Time limit of {TIMEOUT // 60} min reached. Check not concluded."))
        with LOCK:
            JOBS.pop(uid, None)
        WORK.task_done()


def build_share(uid, settings):
    """Standalone HTML page: three.js + engine + data + viewer UI."""
    scene = json.loads((RUNTIME / uid / "scene.json").read_text(encoding="utf-8"))
    keep = ("id", "ref", "name", "material", "material_known", "color", "metalness", "dims",
            "volume_mm3", "mass_g", "vec", "verts", "idx")
    data = {"name": scene.get("name"), "source": SOURCES.get(scene.get("source"), scene.get("source")),
            "units": "mm", "order": scene.get("order", []), "validation": scene.get("validation", {}),
            "plan_origin": scene.get("plan_origin"), "scope": scene.get("scope"),
            "parts": [{k: p.get(k) for k in keep} for p in scene["parts"]],
            "settings": settings, "exported": time.strftime("%Y-%m-%d %H:%M")}
    read = lambda *p: (WEB.joinpath(*p)).read_text(encoding="utf-8")  # noqa: E731
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    title = re.sub(r'[<>&"]', "", str(data["name"]))
    html = (read("share_template.html").replace("/*__CSS__*/", read("style_share.css"))
            .replace("/*__THREE__*/", read("vendor", "three.min.js"))
            .replace("/*__CORE__*/", read("core.js")).replace("/*__SHARE__*/", read("share.js"))
            .replace("__DATA__", payload).replace("__TITLE__", title))
    folder = RUNTIME / uid / "share"
    folder.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9_-]", "_", str(scene.get("name")))[:60] + "_exploded_view.html"
    (folder / name).write_text(html, encoding="utf-8")
    return folder / name


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def send_json(self, obj, code=200):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def send_file(self, path, ctype, download=None):
        payload = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        if download:
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(download)}")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        route = urlparse(self.path)
        query = parse_qs(route.query)
        if route.path == "/api/catalog":
            source = query.get("source", [""])[0]
            needle = query.get("q", [""])[0].strip().lower()
            try:
                offset = max(0, int(query.get("offset", ["0"])[0]))
            except ValueError:
                return self.send_json({"error": "Invalid page"}, 400)
            values = [r for r in CATALOG.values() if (not source or r["source"] == source)
                      and (not needle or needle in r["case"].lower())]
            counts = {s: sum(r["source"] == s for r in CATALOG.values()) for s in SOURCES}
            self.send_json({"total": len(values), "counts": counts, "sources": SOURCES,
                            "items": [{k: v for k, v in r.items() if k != "path"}
                                      for r in values[offset:offset + 60]]})
        elif route.path == "/api/health":
            self.send_json({"ok": True, "catalog": len(CATALOG), "active": list(JOBS)})
        elif route.path.startswith("/api/status/"):
            uid = route.path.rsplit("/", 1)[-1]
            if uid not in CATALOG:
                return self.send_json({"error": "Unknown assembly"}, 404)
            self.send_json(status(uid))
        elif route.path.startswith("/api/scene/"):
            uid = route.path.rsplit("/", 1)[-1]
            p = RUNTIME / uid / "scene.json"
            if uid not in CATALOG or not p.exists():
                return self.send_json({"error": "Geometry not ready"}, 404)
            self.send_file(p, "application/json; charset=utf-8")
        elif route.path.startswith("/files/"):
            # /files/<uid>/<share|snapshots>/<name>
            parts = route.path.split("/")
            if len(parts) != 5 or parts[2] not in CATALOG or parts[3] not in ("share", "snapshots"):
                return self.send_json({"error": "Unknown file"}, 404)
            p = RUNTIME / parts[2] / parts[3] / Path(parts[4]).name
            if not p.exists():
                return self.send_json({"error": "Unknown file"}, 404)
            ctype = "text/html; charset=utf-8" if p.suffix == ".html" else "image/png"
            self.send_file(p, ctype, download=p.name if "download" in query else None)
        else:
            super().do_GET()

    def do_POST(self):
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            return self.send_json({"error": "Origin not allowed"}, 403)
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > (60_000_000 if self.path == "/api/snapshot" else 20_000):
                raise ValueError()
            body = json.loads(self.rfile.read(length))
            uid = body["id"]
            if uid not in CATALOG:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            return self.send_json({"error": "Invalid selection"}, 400)
        if self.path == "/api/open":
            with LOCK:
                if uid not in JOBS and status(uid)["state"] != "done":
                    folder = RUNTIME / uid
                    folder.mkdir(parents=True, exist_ok=True)
                    write_json(folder / "request.json", {**CATALOG[uid], "output": str(folder)})
                    write_json(folder / "status.json", dict(state="queued", progress=0, message="Preparing the model"))
                    JOBS[uid] = {"queued": True}
                    WORK.put(uid)
            self.send_json({"id": uid, **status(uid)})
        elif self.path == "/api/cancel":
            with LOCK:
                job = JOBS.get(uid)
                if job:
                    job["cancelled"] = True
                    if job.get("proc") and job["proc"].poll() is None:
                        job["proc"].terminate()
                    elif job.get("queued"):
                        JOBS.pop(uid, None)
                    write_json(RUNTIME / uid / "status.json",
                               dict(state="cancelled", progress=0, message="Computation stopped on request"))
            self.send_json(status(uid))
        elif self.path == "/api/snapshot":
            name = re.sub(r"[^A-Za-z0-9_-]", "_", str(body.get("name", "view")))[:60]
            data = str(body.get("png", ""))
            if not data.startswith("data:image/png;base64,"):
                return self.send_json({"error": "Invalid image"}, 400)
            folder = RUNTIME / uid / "snapshots"
            folder.mkdir(parents=True, exist_ok=True)
            out = folder / f"{name}.png"
            out.write_bytes(base64.b64decode(data.split(",", 1)[1]))
            self.send_json({"url": f"/files/{uid}/snapshots/{out.name}"})
        elif self.path == "/api/share":
            if not (RUNTIME / uid / "scene.json").exists():
                return self.send_json({"error": "View not ready yet"}, 409)
            settings = body.get("settings", {})
            out = build_share(uid, settings if isinstance(settings, dict) else {})
            self.send_json({"url": f"/files/{uid}/share/{out.name}",
                            "size_mb": round(out.stat().st_size / 1e6, 1)})
        else:
            self.send_json({"error": "Unknown route"}, 404)

    def log_message(self, *args):
        pass


def main(argv=None):
    ap = argparse.ArgumentParser(description="CAD Studio local server")
    ap.add_argument("--port", type=int, default=8780)
    a = ap.parse_args(argv)
    RUNTIME.mkdir(parents=True, exist_ok=True)
    index_data()
    threading.Thread(target=runner, daemon=True).start()
    print(f"CAD Studio: http://127.0.0.1:{a.port}/ · {len(CATALOG)} models", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
