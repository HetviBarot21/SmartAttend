#!/usr/bin/env python
"""Hyperparameter tuning + a stronger model + threshold tuning, on top of train.py.

train.py's baseline (evaluation_report.json, 2026-09-04) used fixed,
untuned RandomForest params and the sklearn-default 0.5 decision threshold.
Logistic Regression beat it on every metric - a sign the RF was never given a
real chance. This script:

  1. Tunes RandomForest via RandomizedSearchCV, scored on out-of-time folds
     (ForwardChainingCV) so no future data ever informs a training fold.
  2. Tries HistGradientBoostingClassifier the same way - native NaN handling,
     usually stronger than a plain RF on tabular data this size.
  3. Picks a decision threshold from out-of-fold predictions on the SCH-01
     training period ONLY (never touches SCH-01 test or SCH-02), maximising
     F1, then applies that one fixed threshold everywhere.
  4. Evaluates the tuned RF, tuned HGB, and the original fixed-threshold
     baselines side by side on SCH-01 test and the SCH-02 holdout school.

Reuses train.py's cached supervised tables (ml/data/supervised_*.pkl) - no
data changes, so results are directly comparable to evaluation_report.json.
The 7 features and the label definition are untouched; nothing in the app
(client or server risk model, rule-based scorer) is affected by this script.

Usage
-----
    cd ml && ./venv/Scripts/python.exe training/tune.py
    ./venv/Scripts/python.exe training/tune.py --n-iter 8 --n-jobs 2   # lighter run
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from scipy.stats import randint, uniform
from sklearn.base import clone
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.model_selection import RandomizedSearchCV
from sklearn.pipeline import Pipeline

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from feature_engineering import FEATURE_NAMES  # noqa: E402
from temporal_split import ForwardChainingCV, temporal_train_test_split  # noqa: E402
from train import (  # noqa: E402
    ENROLMENT_MARGIN_DAYS,
    LABEL_HORIZON_DAYS,
    MODEL_LABELS,
    MODELS_DIR,
    RESULTS_DIR,
    SEED,
    TEST_SIZE,
    _dataset_stats,
    _locate,
    _xy,
    evaluate,
    supervised_table,
)

REPO_ROOT = _HERE.parent.parent


# --------------------------------------------------------------------------- #
# Search spaces                                                               #
# --------------------------------------------------------------------------- #


def rf_search_space() -> dict:
    return {
        "rf__n_estimators": randint(150, 600),
        "rf__max_depth": [4, 6, 8, 10, 14, None],
        "rf__min_samples_leaf": randint(2, 40),
        "rf__min_samples_split": randint(2, 20),
        "rf__max_features": ["sqrt", "log2", 0.5, 0.7, None],
        "rf__class_weight": ["balanced", "balanced_subsample"],
    }


def hgb_search_space() -> dict:
    return {
        "learning_rate": uniform(0.02, 0.28),
        "max_iter": randint(80, 400),
        "max_leaf_nodes": randint(7, 63),
        "min_samples_leaf": randint(10, 80),
        "l2_regularization": uniform(0.0, 2.0),
        "max_depth": [None, 3, 4, 5, 6, 8],
    }


def make_rf_pipeline() -> Pipeline:
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median")),
            ("rf", RandomForestClassifier(random_state=SEED, n_jobs=1)),
        ]
    )


def make_hgb() -> HistGradientBoostingClassifier:
    # HGB handles NaN splits natively - no imputer needed.
    return HistGradientBoostingClassifier(random_state=SEED, class_weight="balanced")


# --------------------------------------------------------------------------- #
# Threshold selection - out-of-fold on the training period only               #
# --------------------------------------------------------------------------- #


def best_threshold_from_oof(y_true: np.ndarray, proba: np.ndarray) -> tuple[float, float]:
    """Threshold in (0, 1) maximising F1, scanned at 0.01 resolution."""
    best_t, best_f1 = 0.5, -1.0
    for t in np.arange(0.05, 0.96, 0.01):
        pred = (proba >= t).astype(int)
        tp = int(((pred == 1) & (y_true == 1)).sum())
        fp = int(((pred == 1) & (y_true == 0)).sum())
        fn = int(((pred == 0) & (y_true == 1)).sum())
        if tp == 0:
            continue
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        if f1 > best_f1:
            best_t, best_f1 = float(t), f1
    return best_t, best_f1


def evaluate_at_threshold(y_true, proba, threshold: float) -> dict:
    pred = (np.asarray(proba) >= threshold).astype(int)
    return evaluate(y_true, proba, pred)


def oof_predict_proba(estimator, X: pd.DataFrame, y: pd.Series, cv, groups) -> tuple[np.ndarray, np.ndarray]:
    """Out-of-fold predict_proba[:, 1] via ForwardChainingCV's own folds.

    Not sklearn's cross_val_predict - ForwardChainingCV's first block is
    train-only (never a test fold), so the folds are not a full partition of
    X and cross_val_predict refuses that outright. This hand-rolled version
    just leaves samples in that first block uncovered; the caller filters to
    `covered` before scoring, so the threshold is still chosen purely from
    out-of-fold predictions, never from data a fold was trained on.
    """
    proba = np.full(len(X), np.nan)
    covered = np.zeros(len(X), dtype=bool)
    for train_idx, test_idx in cv.split(X, y, groups=groups):
        est = clone(estimator)
        est.fit(X.iloc[train_idx], y.iloc[train_idx])
        proba[test_idx] = est.predict_proba(X.iloc[test_idx])[:, 1]
        covered[test_idx] = True
    return proba, covered


# --------------------------------------------------------------------------- #
# Orchestration                                                               #
# --------------------------------------------------------------------------- #


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sch01", type=Path, default=None)
    ap.add_argument("--sch02", type=Path, default=None)
    ap.add_argument("--n-iter", type=int, default=25, help="RandomizedSearchCV iterations per model")
    ap.add_argument("--cv-splits", type=int, default=4, help="ForwardChainingCV folds")
    ap.add_argument("--n-jobs", type=int, default=3, help="parallel workers (kept modest - low-memory box)")
    args = ap.parse_args(argv)

    sch01_path = args.sch01 or _locate("SCH-01")
    sch02_path = args.sch02 or _locate("SCH-02")

    print("Loading cached supervised tables (from train.py's cache)...")
    table01 = supervised_table(sch01_path)
    table02 = supervised_table(sch02_path)

    train01, test01 = temporal_train_test_split(
        table01, test_size=TEST_SIZE, date_col="as_of", gap=LABEL_HORIZON_DAYS
    )
    X_train, y_train = _xy(train01)
    X_test, y_test = _xy(test01)
    X_holdout, y_holdout = _xy(table02)
    groups = train01["as_of"].to_numpy()

    cv = ForwardChainingCV(n_splits=args.cv_splits, gap=LABEL_HORIZON_DAYS)

    report: dict = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "baseline_report": "ml/results/evaluation_report.json (2026-09-04, untuned)",
        "config": {
            "seed": SEED,
            "n_iter": args.n_iter,
            "cv_splits": args.cv_splits,
            "cv_gap_days": LABEL_HORIZON_DAYS,
            "enrolment_margin_days": ENROLMENT_MARGIN_DAYS,
            "features": list(FEATURE_NAMES),
        },
        "datasets": {
            "sch01_train": _dataset_stats(train01),
            "sch01_test": _dataset_stats(test01),
            "sch02_holdout": _dataset_stats(table02),
        },
        "models": {},
    }

    # ---- Random Forest, tuned ------------------------------------------- #
    print(f"\n[1/2] RandomizedSearchCV: RandomForest, {args.n_iter} iters x {args.cv_splits} folds")
    t0 = time.time()
    rf_search = RandomizedSearchCV(
        make_rf_pipeline(),
        rf_search_space(),
        n_iter=args.n_iter,
        scoring="f1",
        cv=cv,
        n_jobs=args.n_jobs,
        random_state=SEED,
        refit=True,
        verbose=1,
    )
    rf_search.fit(X_train, y_train, groups=groups)
    print(f"  best CV f1={rf_search.best_score_:.4f} in {time.time() - t0:.0f}s")
    print(f"  best params: {rf_search.best_params_}")

    best_rf = rf_search.best_estimator_
    rf_oof, rf_covered = oof_predict_proba(best_rf, X_train, y_train, cv, groups)
    rf_threshold, rf_oof_f1 = best_threshold_from_oof(y_train.to_numpy()[rf_covered], rf_oof[rf_covered])
    print(f"  OOF-tuned threshold={rf_threshold:.2f} (OOF f1={rf_oof_f1:.4f})")

    rf_proba_test = best_rf.predict_proba(X_test)[:, 1]
    rf_proba_holdout = best_rf.predict_proba(X_holdout)[:, 1]

    report["models"]["random_forest_tuned"] = {
        "best_params": {k.replace("rf__", ""): v for k, v in rf_search.best_params_.items()},
        "cv_f1": float(rf_search.best_score_),
        "oof_threshold": rf_threshold,
        "oof_f1_at_threshold": rf_oof_f1,
        "feature_importances": {
            f: float(w) for f, w in zip(FEATURE_NAMES, best_rf.named_steps["rf"].feature_importances_)
        },
        "sch01_test_default_0.5": evaluate(y_test, rf_proba_test, (rf_proba_test >= 0.5).astype(int)),
        "sch01_test_tuned_threshold": evaluate_at_threshold(y_test, rf_proba_test, rf_threshold),
        "sch02_holdout_default_0.5": evaluate(y_holdout, rf_proba_holdout, (rf_proba_holdout >= 0.5).astype(int)),
        "sch02_holdout_tuned_threshold": evaluate_at_threshold(y_holdout, rf_proba_holdout, rf_threshold),
    }

    # ---- HistGradientBoosting, tuned -------------------------------------- #
    print(f"\n[2/2] RandomizedSearchCV: HistGradientBoosting, {args.n_iter} iters x {args.cv_splits} folds")
    t0 = time.time()
    hgb_search = RandomizedSearchCV(
        make_hgb(),
        hgb_search_space(),
        n_iter=args.n_iter,
        scoring="f1",
        cv=cv,
        n_jobs=args.n_jobs,
        random_state=SEED,
        refit=True,
        verbose=1,
    )
    hgb_search.fit(X_train, y_train, groups=groups)
    print(f"  best CV f1={hgb_search.best_score_:.4f} in {time.time() - t0:.0f}s")
    print(f"  best params: {hgb_search.best_params_}")

    best_hgb = hgb_search.best_estimator_
    hgb_oof, hgb_covered = oof_predict_proba(best_hgb, X_train, y_train, cv, groups)
    hgb_threshold, hgb_oof_f1 = best_threshold_from_oof(y_train.to_numpy()[hgb_covered], hgb_oof[hgb_covered])
    print(f"  OOF-tuned threshold={hgb_threshold:.2f} (OOF f1={hgb_oof_f1:.4f})")

    hgb_proba_test = best_hgb.predict_proba(X_test)[:, 1]
    hgb_proba_holdout = best_hgb.predict_proba(X_holdout)[:, 1]

    report["models"]["hist_gradient_boosting_tuned"] = {
        "best_params": dict(hgb_search.best_params_),
        "cv_f1": float(hgb_search.best_score_),
        "oof_threshold": hgb_threshold,
        "oof_f1_at_threshold": hgb_oof_f1,
        "sch01_test_default_0.5": evaluate(y_test, hgb_proba_test, (hgb_proba_test >= 0.5).astype(int)),
        "sch01_test_tuned_threshold": evaluate_at_threshold(y_test, hgb_proba_test, hgb_threshold),
        "sch02_holdout_default_0.5": evaluate(y_holdout, hgb_proba_holdout, (hgb_proba_holdout >= 0.5).astype(int)),
        "sch02_holdout_tuned_threshold": evaluate_at_threshold(y_holdout, hgb_proba_holdout, hgb_threshold),
    }

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    report_path = RESULTS_DIR / "tuning_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    best_key, best_f1 = None, -1.0
    for key in ("random_forest_tuned", "hist_gradient_boosting_tuned"):
        f1 = report["models"][key]["sch01_test_tuned_threshold"]["f1"]
        if f1 > best_f1:
            best_key, best_f1 = key, f1
    best_model = best_rf if best_key == "random_forest_tuned" else best_hgb
    best_threshold = rf_threshold if best_key == "random_forest_tuned" else hgb_threshold
    joblib.dump(
        {"model": best_model, "threshold": best_threshold, "features": list(FEATURE_NAMES)},
        MODELS_DIR / "best_model.pkl",
    )

    # ---- comparison table -------------------------------------------------- #
    header = f"{'Model':<32} {'Eval set':<18} {'Prec':>6} {'Recall':>7} {'F1':>6} {'AUC':>6}"
    print("\n" + "=" * len(header))
    print("TUNED MODEL COMPARISON (tuned decision threshold, chosen out-of-fold)")
    print("=" * len(header))
    print(header)
    print("-" * len(header))
    for key, label in (("random_forest_tuned", "RF (tuned)"), ("hist_gradient_boosting_tuned", "HistGB (tuned)")):
        for eval_key, eval_label in (("sch01_test_tuned_threshold", "SCH-01 test"), ("sch02_holdout_tuned_threshold", "SCH-02 holdout")):
            m = report["models"][key][eval_key]
            print(f"{label:<32} {eval_label:<18} {m['precision']:6.3f} {m['recall']:7.3f} {m['f1']:6.3f} {m['auc_roc']:6.3f}")
    print("-" * len(header))
    print(f"\nBest by SCH-01 test F1 (tuned threshold): {best_key} (f1={best_f1:.3f})")
    print(f"saved -> {report_path.relative_to(REPO_ROOT)}")
    print(f"saved -> {(MODELS_DIR / 'best_model.pkl').relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
