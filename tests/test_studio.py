"""Worker checks and server API on the built-in synthetic samples (needs pythonocc-core)."""
import json
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

pytest.importorskip("OCC")
pytest.importorskip("exploded_view_verifier")

from studio import server, worker  # noqa: E402


def run_worker(tmp_path, case, source="sample", path=""):
    req = {"id": "t", "source": source, "case": case, "path": path, "output": str(tmp_path)}
    worker.run(req)
    status = json.loads((tmp_path / "status.json").read_text(encoding="utf-8"))
    scene = json.loads((tmp_path / "scene.json").read_text(encoding="utf-8"))
    return status, scene


def test_pin_in_plate_scene(tmp_path):
    status, scene = run_worker(tmp_path, "pin_in_plate")
    assert status["state"] == "done"
    v = scene["validation"]
    assert v["final"] == "pass" and v["simultaneous"] == "pass" and v["sequential"] == "pass"
    assert 0 < v["sim_free_from"] <= 1
    assert sorted(scene["order"]) == ["pin", "plate"]
    for p in scene["parts"]:
        assert len(p["verts"]) % 3 == 0 and len(p["idx"]) % 3 == 0 and len(p["vec"]) == 3
        assert p["mass_g"] is None          # no material declared: no mass invented


def test_caged_cube_has_no_disassembly_order(tmp_path):
    _, scene = run_worker(tmp_path, "caged_cube")
    v = scene["validation"]
    assert v["final"] == "pass"
    assert v["sequential"] == "not_found" and scene["order"] == []


def test_step_file_source(tmp_path):
    from exploded_view_verifier.cli import main as cli
    cli(["--write-samples", str(tmp_path / "models")])
    out = tmp_path / "out"
    out.mkdir()
    status, scene = run_worker(out, "pin_in_plate.step", "step", str(tmp_path / "models" / "pin_in_plate.step"))
    assert status["state"] == "done" and len(scene["parts"]) == 2


def _write_datasets(root):
    """Tiny assemblies in the Fusion and AutoMate formats (two boxes side by side)."""
    from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox
    from exploded_view_verifier.geometry import write_step
    fus = root / "fusion" / "demo_fusion"
    fus.mkdir(parents=True)
    write_step([BRepPrimAPI_MakeBox(10, 10, 10).Shape()], fus / "b1.step")
    write_step([BRepPrimAPI_MakeBox(10, 10, 10).Shape()], fus / "b2.step")
    frame = lambda x: {"origin": {"x": x, "y": 0, "z": 0}, "x_axis": {"x": 1, "y": 0, "z": 0},  # noqa: E731
                       "y_axis": {"x": 0, "y": 1, "z": 0}, "z_axis": {"x": 0, "y": 0, "z": 1}}
    (fus / "assembly.json").write_text(json.dumps({
        "bodies": {"b1": {"step": "b1.step", "material": {"name": "Steel"}}, "b2": {"step": "b2.step"}},
        "occurrences": {"o1": {"name": "Block A", "bodies": {"b1": {}}, "transform": frame(0)},
                        "o2": {"name": "Block B", "bodies": {"b2": {}}, "transform": frame(1.0)}},
        "tree": {"root": {"o1": {}, "o2": {}}}}))
    am = root / "automate_asm"
    st = root / "automate_step"
    am.mkdir()
    st.mkdir()
    write_step([BRepPrimAPI_MakeBox(10, 10, 10).Shape()], st / "p1.step")
    eye = lambda tx: [1, 0, 0, tx, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]  # noqa: E731
    (am / "demo_automate.json").write_text(json.dumps({
        "parts": [{"id": "p1", "has_step": True}],
        "occurrences": [{"id": "a", "part": 0, "transform": eye(0)},
                        {"id": "b", "part": 0, "transform": eye(0.01)}]}))


def test_dataset_sources(tmp_path, monkeypatch):
    data = tmp_path / "data"
    _write_datasets(data)
    monkeypatch.setattr(server, "DATA", data)
    server.index_data()
    kinds = sorted((r["source"], r["case"]) for r in server.CATALOG.values() if r["source"] != "sample")
    assert kinds == [("automate", "demo_automate"), ("fusion", "demo_fusion")]
    for r in server.CATALOG.values():
        if r["source"] == "sample":
            continue
        out = tmp_path / r["source"]
        out.mkdir()
        status, scene = run_worker(out, r["case"], r["source"], r["path"])
        assert status["state"] == "done" and len(scene["parts"]) == 2
        assert scene["validation"]["final"] == "pass"
        if r["source"] == "fusion":
            a = next(p for p in scene["parts"] if p["name"] == "Block A")
            assert a["material"] == "Steel" and a["mass_g"] == pytest.approx(7.85, rel=1e-3)


def _get(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read())


def _post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def test_server_flow(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "RUNTIME", tmp_path)
    monkeypatch.setattr(server, "DATA", tmp_path / "none")
    server.index_data()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    threading.Thread(target=server.runner, daemon=True).start()
    try:
        cat = _get(base + "/api/catalog?source=sample")
        assert cat["total"] == 3
        item = next(i for i in cat["items"] if i["case"] == "pin_in_plate")
        assert "path" not in item
        _post(base + "/api/open", {"id": item["id"]})
        for _ in range(300):
            st = _get(base + "/api/status/" + item["id"])
            if st["state"] in ("done", "error", "timeout"):
                break
            time.sleep(0.5)
        assert st["state"] == "done", st
        scene = _get(base + "/api/scene/" + item["id"])
        assert scene["validation"]["final"] == "pass"
        share = _post(base + "/api/share", {"id": item["id"], "settings": {}})
        with urllib.request.urlopen(base + share["url"], timeout=10) as r:
            html = r.read().decode("utf-8")
        assert "const DATA = " in html and "pin_in_plate" in html
        with pytest.raises(urllib.error.HTTPError):
            _post(base + "/api/open", {"id": "nope"})
    finally:
        httpd.shutdown()
