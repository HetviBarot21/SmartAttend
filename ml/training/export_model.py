#!/usr/bin/env python
"""Export the trained HistGradientBoosting model to portable JSON for JS.

The app is offline-first (a teacher on a phone with no signal still needs
risk flags), so "wire the model into the app" cannot mean a live inference
API call - it means shipping the model's decision logic as a static asset
both the client PWA and the server can walk with plain arithmetic, no
Python runtime involved. HistGB was chosen for exactly this over the tuned
Random Forest: its trees are tiny by construction (max_leaf_nodes=7 during
tuning), so the whole 161-tree ensemble exports to well under a couple
hundred KB of JSON - trivial to bundle.

Algorithm this JSON supports (verified against model._raw_predict /
predict_proba on real samples before trusting this export - see the
commit message for the check):

    raw = baseline
    for each tree:
        walk from node 0: if not leaf, go to `left` when
          (value <= threshold), or when the feature is NaN and
          `missingLeft` is true; otherwise go `right`. Repeat until a leaf.
        raw += leaf's `value` (already learning-rate-scaled - do NOT
          multiply by a learning rate again)
    probability = sigmoid(raw)
    flag = 'red' if probability >= threshold, else 'amber' if probability
      >= threshold * AMBER_FRACTION, else 'green'  (see export below)

Usage: cd ml && ./venv/Scripts/python.exe training/export_model.py
"""
from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np

ML_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = ML_DIR.parent

# Same amber/red split style as the existing rule-based scorer (red >=0.6,
# amber >=0.35 of red's threshold) - keeps the UI's two-tier severity language
# consistent even though the underlying score now comes from a real model.
AMBER_FRACTION = 0.35 / 0.60


def export_tree(tree_predictor) -> dict:
    nodes = tree_predictor.nodes
    return {
        "feature": [int(n["feature_idx"]) for n in nodes],
        "threshold": [float(n["num_threshold"]) for n in nodes],
        "missingLeft": [bool(n["missing_go_to_left"]) for n in nodes],
        "left": [int(n["left"]) for n in nodes],
        "right": [int(n["right"]) for n in nodes],
        "isLeaf": [bool(n["is_leaf"]) for n in nodes],
        "value": [float(n["value"]) for n in nodes],
    }


def main() -> int:
    blob = joblib.load(ML_DIR / "models" / "best_model.pkl")
    model = blob["model"]
    features = list(blob["features"])
    threshold = float(blob["threshold"])

    trees = [export_tree(model._predictors[it][0]) for it in range(model.n_iter_)]
    baseline = float(np.asarray(model._baseline_prediction).ravel()[0])

    export = {
        "kind": "hist_gradient_boosting",
        "baseline": baseline,
        "features": features,
        "redThreshold": threshold,
        "amberThreshold": threshold * AMBER_FRACTION,
        "trees": trees,
    }

    # Sanity-check the export against the live model before writing anything -
    # a silently-wrong port is worse than no port at all.
    rng = np.random.default_rng(42)
    import pandas as pd

    def predict_from_export(row: dict) -> float:
        raw = export["baseline"]
        for tree in export["trees"]:
            idx = 0
            while not tree["isLeaf"][idx]:
                v = row[export["features"][tree["feature"][idx]]]
                go_left = (v <= tree["threshold"][idx]) if v == v else tree["missingLeft"][idx]
                idx = tree["left"][idx] if go_left else tree["right"][idx]
            raw += tree["value"][idx]
        return 1.0 / (1.0 + np.exp(-raw))

    max_diff = 0.0
    for _ in range(200):
        row = {f: (rng.uniform(0, 1) if rng.random() > 0.15 else float("nan")) for f in features}
        row["longest_absence_streak"] = rng.integers(0, 20)
        row["absence_episode_count"] = rng.integers(0, 8)
        row["days_into_term"] = rng.integers(0, 100)
        X = pd.DataFrame([row])[features]
        sklearn_proba = float(model.predict_proba(X)[0, 1])
        export_proba = predict_from_export(row)
        max_diff = max(max_diff, abs(sklearn_proba - export_proba))
    print(f"sanity check over 200 random rows (incl. NaNs): max |diff| = {max_diff:.2e}")
    assert max_diff < 1e-6, "export does not match the live model - not writing the file"

    out_path = ML_DIR / "models" / "hgb_export.json"
    out_path.write_text(json.dumps(export), encoding="utf-8")
    n_nodes = sum(len(t["isLeaf"]) for t in trees)
    print(f"wrote {out_path} - {len(trees)} trees, {n_nodes} nodes total, {out_path.stat().st_size / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
