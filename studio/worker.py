"""Prepare a studio scene for one assembly (run in a separate process by server.py).

Checks (all from ``exploded_view_verifier``):

* final layout: interference verifier (an undetermined pair is never accepted);
* "all at once": the verifier at 24 fractions of the displacement; the smallest fraction
  from which every sampled state is conflict-free is reported;
* "part by part": straight-line sequential disassembly test, with its feasibility repair
  when needed, then a deterministic order whose *displayed* motion does not cross a part
  already removed.

These are finite samples of rigid translations, NOT a proof of continuous clearance, nor
of joint, fastener or rotation kinematics. No LLM and no network service is called.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import sys
import tempfile
import time
import traceback
from itertools import combinations
from pathlib import Path

from exploded_view_verifier import disassembly as D
from exploded_view_verifier import geometry as G
from exploded_view_verifier import oracle as O
from exploded_view_verifier import samples as SAMPLES
from exploded_view_verifier.proposers import RandomProposer, centroid_plan
from exploded_view_verifier.repair import deterministic_spread, feasibility_repair, residual_loop

STEPS = 24
TOL = G.TOL
DEFL = G.DEFLECTION
SEED = 20261013


def write_json(path, value):
    """Atomic JSON write (tolerates brief Windows file locks)."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, allow_nan=False)
        for attempt in range(30):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 29:
                    raise
                time.sleep(0.05)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


# ----------------------------------------------------------------------------- geometry
def load_geometry(req):
    if req["source"] == "sample":
        occ = SAMPLES.build(req["case"], DEFL)
        meta = {p: {"name": p.replace("_", " "), "materials": []} for p in occ}
    elif req["source"] == "fusion":
        from exploded_view_verifier.datasets import load_fusion
        occ, names = load_fusion(req["path"], deflection=DEFL)
        meta = {p: {"name": names.get(p, p), "materials": _fusion_materials(req["path"], p)} for p in occ}
    elif req["source"] == "automate":
        from exploded_view_verifier.datasets import load_automate
        asm_json, step_dir = req["path"].split("|", 1)
        occ, names = load_automate(asm_json, step_dir, deflection=DEFL)
        meta = {p: {"name": names.get(p, p), "materials": []} for p in occ}
    else:
        occ = G.load_step_assembly(req["path"], DEFL)
        meta = {p: {"name": f"Solid {k + 1}", "materials": []} for k, p in enumerate(occ)}
    if not occ:
        raise ValueError("No usable STEP geometry in this model.")
    return occ, meta


def _fusion_materials(assembly_json, part_id):
    """Material names declared in a Fusion assembly.json for one occurrence (or body)."""
    data = json.loads(Path(assembly_json).read_text(encoding="utf-8"))
    occ = (data.get("occurrences") or {}).get(part_id)
    bodies = list((occ.get("bodies") or {}).keys()) if occ else [part_id]
    out = []
    for bid in bodies:
        mat = ((data.get("bodies") or {}).get(bid) or {}).get("material")
        name = mat.get("name") if isinstance(mat, dict) else mat
        if name and str(name) not in out:
            out.append(str(name))
    return out


def triangulate(shapes):
    """Flat world-space vertex and index lists of the (already meshed) solids of a part."""
    from OCC.Core.BRep import BRep_Tool
    from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCC.Core.TopExp import TopExp_Explorer
    from OCC.Core.TopoDS import topods
    verts, idx = [], []
    for s in shapes:
        exp = TopExp_Explorer(s, TopAbs_FACE)
        while exp.More():
            face = topods.Face(exp.Current())
            loc = face.Location()
            tri = BRep_Tool.Triangulation(face, loc)
            if tri is not None and tri.NbNodes() > 0:
                trsf = loc.Transformation()
                base = len(verts) // 3
                for k in range(1, tri.NbNodes() + 1):
                    p = tri.Node(k).Transformed(trsf)
                    verts += [round(p.X(), 3), round(p.Y(), 3), round(p.Z(), 3)]
                rev = face.Orientation() == TopAbs_REVERSED
                for k in range(1, tri.NbTriangles() + 1):
                    a, b, c = tri.Triangle(k).Get()
                    if rev:
                        a, c = c, a
                    idx += [base + a - 1, base + b - 1, base + c - 1]
            exp.Next()
    return verts, idx


def dims_of(shapes):
    xmin, ymin, zmin, xmax, ymax, zmax = G.combined_bbox(shapes).Get()
    return [round(xmax - xmin, 1), round(ymax - ymin, 1), round(zmax - zmin, 1)]


def volume_of(shapes):
    from OCC.Core.GProp import GProp_GProps
    from OCC.Core.BRepGProp import brepgprop
    v = 0.0
    for s in shapes:
        g = GProp_GProps()
        brepgprop.VolumeProperties(s, g)
        v += abs(g.Mass())
    return v


# Usual densities (g/cm3), used ONLY when a material is declared in the source data.
DENSITY = [(["stainless"], 8.0), (["steel"], 7.85), (["iron"], 7.2), (["alumin"], 2.7),
           (["titan"], 4.5), (["brass"], 8.5), (["bronze"], 8.8), (["copper"], 8.96),
           (["abs"], 1.04), (["nylon", "polyamide"], 1.15), (["polycarbonate"], 1.2),
           (["acetal", "pom"], 1.41), (["rubber"], 1.2), (["wood"], 0.6), (["glass"], 2.5)]
MATERIAL_STYLE = [(["stainless", "steel"], "#94a8b6", .7), (["alumin"], "#c3cdd1", .65),
                  (["brass"], "#c7a350", .7), (["copper"], "#c47a56", .7), (["bronze"], "#ac8055", .6),
                  (["iron"], "#626a74", .65), (["rubber"], "#3e4752", .05),
                  (["nylon", "plastic", "abs", "acetal", "poly"], "#d8d4c9", .05), (["wood"], "#a97950", .05)]


def _lookup(table, materials, default):
    n = " / ".join(materials).lower()
    for words, *val in table:
        if any(w in n for w in words):
            return val if len(val) > 1 else val[0]
    return default


def geometry_scene(occ, meta, plan, req):
    parts = []
    for i, (pid, shapes) in enumerate(occ.items()):
        verts, idx = triangulate(shapes)
        materials = meta[pid]["materials"]
        color, metal = _lookup(MATERIAL_STYLE, materials, ["#a5afbd", .2 if materials else .08])
        rho = _lookup(DENSITY, materials, None)
        vol = volume_of(shapes)
        parts.append(dict(id=pid, ref=i + 1, name=meta[pid]["name"],
                          material=" / ".join(materials) or "Not specified",
                          material_known=bool(materials), color=color, metalness=metal, quantity=1,
                          dims=dims_of(shapes), volume_mm3=round(vol, 3), density_g_cm3=rho,
                          mass_g=round(vol * rho / 1000.0, 3) if rho else None,
                          vec=plan[pid], verts=verts, idx=idx))
    return dict(id=req["id"], name=req["case"], source=req["source"], units="mm", parts=parts,
                order=[], missing=[], steps=STEPS, tolerance_mm=TOL,
                validation=dict(final="pending", sequential="pending", simultaneous="pending"),
                scope=("Rigid translations only. Final layout and 'all at once' states checked by the "
                       "interference verifier at 24 fractions of the displacement. 'Part by part': "
                       "straight-line removal test, and the displayed path of each part checked "
                       "against the parts already removed (24 positions). Joints, threads and "
                       "rotations are not checked; a discrete check does not cover the whole "
                       "continuous motion."))


# ----------------------------------------------------------------------------- checks
def _placed(occ, plan, frac=1.0, only=None):
    ids = occ if only is None else only
    return {i: G.translate(occ[i], [x * frac for x in plan[i]], DEFL) for i in ids}


def first_conflict(occ, plan, frac):
    placed = _placed(occ, plan, frac)
    boxes = {i: G.combined_bbox(sh) for i, sh in placed.items()}
    for bx in boxes.values():
        bx.Enlarge(TOL)
    for a, b in combinations(list(placed), 2):
        if boxes[a].IsOut(boxes[b]):
            continue
        kind = O.part_pair_verdict(placed[a], placed[b], TOL)
        if kind != O.FREE:
            return [str(a), str(b), kind]
    return None


def sim_free_from(occ, plan, progress=lambda *a: None):
    """Smallest fraction k/STEPS from which every sampled state is conflict-free (scanning
    down from 100 %), and the first conflict met."""
    free_from, hit = None, None
    for k in range(STEPS, 0, -1):
        progress(45 + 30 * (STEPS - k + 1) / STEPS, f"Exploded view at {round(100 * k / STEPS)} %")
        hit = first_conflict(occ, plan, k / STEPS)
        if hit:
            break
        free_from = k
    return (None if free_from is None else free_from / STEPS), hit


def _motion_issue(occ, plan, i, final, fb):
    """Part i travelling along its vector (k/STEPS) against parts already at their final place."""
    if not final:
        return None
    for k in range(1, STEPS + 1):
        mi = _placed(occ, plan, k / STEPS, [i])[i]
        bi = G.combined_bbox(mi)
        bi.Enlarge(TOL)
        for j, sj in final.items():
            if bi.IsOut(fb[j]):
                continue
            kind = O.part_pair_verdict(mi, sj, TOL)
            if kind != O.FREE:
                return {"moving": str(i), "obstacle": str(j), "sample": k, "kind": kind}
    return None


def _set_final(occ, plan, i, final, fb):
    final[i] = _placed(occ, plan, 1.0, [i])[i]
    fb[i] = G.combined_bbox(final[i])


def displayed_sequence_issue(occ, plan, order):
    final, fb = {}, {}
    for i in order:
        issue = _motion_issue(occ, plan, i, final, fb)
        if issue:
            return issue
        _set_final(occ, plan, i, final, fb)
    return None


def display_valid_order(occ, plan, progress=lambda *a: None):
    """Deterministic order in which every removed part passes the straight-line removal
    test AND its displayed path crosses no part already removed. Returns (order, None) or
    (None, reason)."""
    ids = sorted(occ, key=str)
    final, fb = {}, {}
    for i in ids:
        _set_final(occ, plan, i, final, fb)
    before = {}
    for n, i in enumerate(ids):
        before[i] = set()
        rest = [j for j in ids if j != i]
        while rest:     # every part whose final place is crossed by the path of i
            hit = _motion_issue(occ, plan, i, {j: final[j] for j in rest}, fb)
            if not hit:
                break
            j = next(x for x in rest if str(x) == hit["obstacle"])
            before[i].add(j)
            rest.remove(j)
        progress(86 + 6 * (n + 1) / len(ids), f"Displayed paths · {n + 1}/{len(ids)}")
    state = D.assembled_state(occ, TOL)
    travel = 1.5 * state[2]
    contact0 = state[3]
    remaining, order = list(ids), []
    while remaining:
        ready, removable = [], False
        for i in remaining:
            others = set(remaining) - {i}
            d = D._unit(plan.get(i, [0, 0, 0]))
            ok = (not any(contact0[(i, j)] for j in others)) if d is None else \
                D.is_removable(i, others, occ, state, d, travel, 8, TOL, DEFL)
            if not ok:
                continue
            removable = True
            if not (before[i] & set(order)):
                ready.append(i)
        if not ready:
            return None, ("display" if removable else "blocked")
        free = [i for i in ready if not any(i in before[r] for r in remaining if r != i)]
        chosen = (free or ready)[0]
        order.append(chosen)
        remaining.remove(chosen)
    return order, None


# ----------------------------------------------------------------------------- main
def run(req):
    folder = Path(req["output"])

    def progress(value, message):
        write_json(folder / "status.json", dict(state="running", progress=round(value), message=message))

    progress(3, "Reading the STEP geometry")
    with contextlib.redirect_stdout(io.StringIO()):
        occ, meta = load_geometry(req)
    progress(13, f"{len(occ)} parts loaded · building the bill of materials")
    plan = centroid_plan(occ, 2.0)
    scene = geometry_scene(occ, meta, plan, req)
    scene["plan_origin"] = "Geometric proposal · centroid"
    write_json(folder / "scene.json", scene)

    progress(25, "Geometry available · checking the final layout")
    details = {}
    coll = O.verify_plan(occ, plan, TOL, DEFL, details=details)
    if coll and len(occ) > 1:
        progress(32, "Looking for a clearer layout (axial spreading)")
        plan2, coll2, _ = deterministic_spread(occ, 2.0, TOL, DEFL, 4)
        if len(coll2) < len(coll):
            plan, coll = plan2, coll2
            scene["plan_origin"] = "Axial spreading · verified"
        if coll:
            progress(38, "Random residual repair")
            plan3, coll3, _ = residual_loop(occ, plan, coll, RandomProposer(SEED), budget=4,
                                            case_id=req["case"])
            if len(coll3) < len(coll):
                plan, coll = plan3, coll3
                scene["plan_origin"] = "Random residual repair · verified"
        details = {}
        coll = O.verify_plan(occ, plan, TOL, DEFL, details=details)
    for part in scene["parts"]:
        part["vec"] = plan[part["id"]]
    v = scene["validation"]
    v["final"] = "unknown" if any(x == O.UNDET for x in details.values()) else ("blocked" if coll else "pass")
    v["final_conflicts"] = [dict(pair=list(pair), reason=kind) for pair, kind in details.items()]
    v["oracle_version"] = O.ORACLE_VERSION
    write_json(folder / "scene.json", scene)

    if len(occ) == 1:
        v.update(sequential="not_applicable", simultaneous="not_applicable",
                 message="Single part: no disassembly sequence to compute.")
    elif v["final"] != "pass":
        v.update(sequential="unknown", simultaneous="unknown",
                 message="Final layout not accepted: animation not checked.")
    else:
        ff, hit = sim_free_from(occ, plan, progress)
        free_from = None if ff is None else round(ff * STEPS)
        v["simultaneous"] = "pass" if free_from is not None else "blocked"
        v["sim_first_conflict_below"] = hit
        v["sim_free_from"] = None if free_from is None else free_from / STEPS
        write_json(folder / "scene.json", scene)
        progress(78, "Disassembly order · straight-line removal test")
        feasible, order, stuck = D.sequential_disassembly(occ, plan, 8, TOL, DEFL)
        if not feasible:
            progress(84, "Feasibility repair · verifier kept")
            plan2, fa, order2, stuck2, _ = feasibility_repair(occ, plan, steps=8, max_iter=3)
            if fa and not O.verify_plan(occ, plan2, TOL, DEFL):
                plan, feasible, order, stuck = plan2, True, order2, stuck2
                for part in scene["parts"]:
                    part["vec"] = plan[part["id"]]
                scene["plan_origin"] += " · feasibility repair"
        scene["order"] = [str(o) for o in order] if feasible else []
        v["sequential"] = "pass" if feasible else "not_found"
        v["sequential_stuck"] = [str(o) for o in stuck]
        if feasible:
            shown, _ = display_valid_order(occ, plan, progress)
            if shown:
                scene["order"] = [str(o) for o in shown]
                v["sequential_display_issue"] = None
            else:
                issue = displayed_sequence_issue(occ, plan, order)
                v["sequential_display_issue"] = issue
                if issue:
                    v["sequential"] = "display_conflict"
        v["message"] = ("Checks finished. 'All at once' view conflict-free from "
                        + (f"{round(100 * free_from / STEPS)} %" if free_from else "—")
                        + " of the displacement.")
    write_json(folder / "scene.json", scene)
    write_json(folder / "status.json", dict(state="done", progress=100, message="Model ready · checks available"))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--request", required=True)
    a = ap.parse_args(argv)
    req = json.loads(Path(a.request).read_text(encoding="utf-8"))
    try:
        run(req)
    except Exception as error:
        traceback.print_exc()
        write_json(Path(req["output"]) / "status.json",
                   dict(state="error", progress=0,
                        message=f"Check not concluded: {type(error).__name__} · {str(error)[:220]}"))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
