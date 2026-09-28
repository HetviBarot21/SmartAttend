#!/usr/bin/env python
"""Export the trained HistGradientBoosting model to portable JSON for JS.

The app works offline, so the client and server walk these trees in plain JS.

How the JSON is evaluated:

    raw = baseline
    for each tree:
        walk from node 0: if not leaf, go to `left` when
          (value <= threshold), or when the feature is NaN and
          `missingLeft` is true; otherwise go `right`. Repeat until a leaf.
        raw += leaf's `value` (already scaled by the learning rate)
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

    # Check the export against the live model before writing it.
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
