#!/usr/bin/env python
"""Train and evaluate the SmartAttend AI persistent-absenteeism models.

Pipeline position
-----------------
    raw xlsx  (Daily Attendance + School Calendar sheets)
      -> normalise statuses / ids, build a per-school SchoolCalendar
      -> compute_labels.build_training_table   (7 features + label per student/as_of)
      -> temporal_split.temporal_train_test_split   (SCH-01 only; SCH-02 held out whole)
      -> {RandomForest, LogisticRegression, rule-based}  fit on the SCH-01 train split
      -> evaluate on the SCH-01 test split  and  the full SCH-02 unseen school
      -> ml/models/rf_model.pkl , ml/results/evaluation_report.json

Everything is seeded (42) and strictly time-ordered. No row dated on or after the
SCH-01 split boundary reaches the training set, and a gap equal to the label
horizon (28 days) is removed *ahead* of the boundary so a training row's forward
label window cannot cross it (temporal_split.temporal_train_test_split(gap=...)).
SCH-02 is never fitted on - it measures generalisation to an unseen school.

The heavy step is building the supervised table from ~350k-450k attendance rows;
it is cached to ml/data/supervised_<file>.pkl and reused until the xlsx or the
pipeline version changes. Use --rebuild to force it, --max-students N for a fast
dry run.

Usage
-----
    cd ml && ./venv/Scripts/python.exe training/train.py
    ./venv/Scripts/python.exe training/train.py --max-students 50 --rebuild

Requires: scikit-learn, joblib, pandas, numpy, openpyxl.
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
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    confusion_matrix,
    precision_recall_fscore_support,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

# The sibling pipeline modules import each other by bare name; match that.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from compute_labels import LABEL_NAME, build_training_table  # noqa: E402
from feature_engineering import (  # noqa: E402
    FEATURE_NAMES,
    SchoolCalendar,
    _as_date,
    categorize_reason,
)
from temporal_split import temporal_train_test_split  # noqa: E402

# --------------------------------------------------------------------------- #
# Configuration - fixed so a run is reproducible                              #
# --------------------------------------------------------------------------- #

SEED = 42
LABEL_HORIZON_DAYS = 28           # matches compute_labels.FOUR_WEEKS
PERSISTENT_ABSENCE_THRESHOLD = 0.30
FEATURE_BUILD_STEP_DAYS = 14      # cadence of as_of reference dates
TEST_SIZE = 0.20                  # fraction of distinct SCH-01 dates held for test
ENROLMENT_MARGIN_DAYS = 14        # drop samples this close to a student's first/last record
CACHE_VERSION = 2                 # bump to invalidate ml/data/supervised_*.pkl

ML_DIR = _HERE.parent
REPO_ROOT = ML_DIR.parent
DATA_DIR = ML_DIR / "data"
MODELS_DIR = ML_DIR / "models"
RESULTS_DIR = ML_DIR / "results"

np.random.seed(SEED)

# --------------------------------------------------------------------------- #
# Raw data -> normalised attendance events + school calendar                  #
# --------------------------------------------------------------------------- #

# The Daily Attendance sheet spells each status ~14 ways ("P", "pres",
# "PRESENT", "Present", "present", ...). Everything else is dropped and counted.
_STATUS_MAP = {
    "p": "present", "pres": "present", "present": "present",
    "a": "absent", "abs": "absent", "absent": "absent",
    "l": "late", "late": "late",
}


def _normalise_status(series: pd.Series) -> pd.Series:
    return series.astype(str).str.strip().str.lower().map(_STATUS_MAP)


def load_daily_attendance(xlsx_path: Path) -> pd.DataFrame:
    """Daily Attendance sheet -> tidy frame: student_id, date, status.

    Admission numbers are upper-cased (the sheet mixes "ADM01432" / "adm01432"),
    statuses are normalised to present/absent/late, unmapped rows are dropped,
    and a (student, date) collision keeps the last row after a stable sort.
    """
    raw = pd.read_excel(xlsx_path, sheet_name="Daily Attendance")
    df = pd.DataFrame(
        {
            "student_id": raw["admission_no"].astype(str).str.strip().str.upper(),
            "date": pd.to_datetime(raw["date"]).dt.date,
            "status": _normalise_status(raw["status"]),
        }
    )
    dropped = int(df["status"].isna().sum())
    df = df.dropna(subset=["status"])
    df = (
        df.sort_values(["student_id", "date"], kind="stable")
        .drop_duplicates(["student_id", "date"], keep="last")
        .reset_index(drop=True)
    )
    df.attrs["dropped_unmapped_status"] = dropped
    return df


def load_calendar(xlsx_path: Path) -> SchoolCalendar:
    """School Calendar sheet -> SchoolCalendar over the exact school_day set.

    Each scheduled day becomes a one-day 'term' with no weekend rule and no
    holidays, so SchoolCalendar._materialise reproduces precisely the days the
    sheet marks 'school_day' (2017-2024) - the 2026 kenya_calendar.json does not
    cover this data.
    """
    raw = pd.read_excel(xlsx_path, sheet_name="School Calendar")
    days = sorted(
        {
            _as_date(d)
            for d, kind in zip(raw["date"], raw["day_type"].astype(str))
            if kind.strip() == "school_day"
        }
    )
    if not days:
        raise ValueError(f"{xlsx_path.name}: no 'school_day' rows in School Calendar sheet")
    terms = [(f"d{i}", d, d) for i, d in enumerate(days)]
    return SchoolCalendar(
        terms=terms, public_holidays=(), weekend_weekdays=(), name=xlsx_path.stem
    )


def load_term_bounds(xlsx_path: Path) -> list[tuple[str, dt.date, dt.date]]:
    """School Calendar sheet's own ``term`` column -> ``[(name, start, end), ...]``.

    Distinct from :func:`load_calendar`'s flat school-day list (used for rate
    windows regardless of term structure) - this is specifically the term
    boundaries `attendance_rate_term` / `days_into_term` need. "Inter-term
    holiday" is not a real term and is dropped; a reference date landing there
    correctly gets no enclosing term (features 10-11 come back nan).
    """
    raw = pd.read_excel(xlsx_path, sheet_name="School Calendar")
    raw = raw[raw["term"].astype(str).str.strip() != "Inter-term holiday"]
    bounds: list[tuple[str, dt.date, dt.date]] = []
    for name, group in raw.groupby("term"):
        dates = [_as_date(d) for d in group["date"]]
        bounds.append((str(name), min(dates), max(dates)))
    return sorted(bounds, key=lambda t: t[1])


def load_absence_reasons(xlsx_path: Path) -> dict[str, dict[dt.date, str]]:
    """"Absence Reasons" sheet -> ``{student_id: {date: 'fee'|'health'}}``.

    Only categorisable reasons are kept (see
    :func:`feature_engineering.categorize_reason`); everything else - burial,
    farm work, "unknown", missing - is simply absent from the per-student dict,
    which is exactly what `reason_absence_rate` treats as "not fee, not health".
    """
    raw = pd.read_excel(xlsx_path, sheet_name="Absence Reasons")
    out: dict[str, dict[dt.date, str]] = {}
    for row in raw.itertuples(index=False):
        category = categorize_reason(row.reason_note)
        if category is None:
            continue
        student_id = str(row.admission_no).strip().upper()
        day = _as_date(row.date)
        out.setdefault(student_id, {})[day] = category
    return out


def _drop_out_of_enrolment(table: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    """Remove samples whose as_of sits outside a student's active span.

    A student with a handful of records otherwise contributes hundreds of
    all-absent windows (a scheduled day with no record counts as an absence),
    which are noise, not signal. The span is [first record, last record]; a
    margin keeps the feature/label windows genuinely inside it.
    """
    if table.empty:
        return table
    first = pd.to_datetime(events.groupby("student_id")["date"].min())
    last = pd.to_datetime(events.groupby("student_id")["date"].max())
    lo = table["student_id"].map(first) + pd.Timedelta(days=ENROLMENT_MARGIN_DAYS)
    hi = table["student_id"].map(last) - pd.Timedelta(days=ENROLMENT_MARGIN_DAYS)
    as_of = pd.to_datetime(table["as_of"])
    keep = as_of.ge(lo) & as_of.le(hi)
    return table.loc[keep].reset_index(drop=True)


def _cache_key(xlsx_path: Path, max_students: int) -> dict:
    st = xlsx_path.stat()
    return {
        "file": xlsx_path.name,
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        "step_days": FEATURE_BUILD_STEP_DAYS,
        "threshold": PERSISTENT_ABSENCE_THRESHOLD,
        "enrolment_margin": ENROLMENT_MARGIN_DAYS,
        "version": CACHE_VERSION,
        "max_students": max_students,
    }


def supervised_table(
    xlsx_path: Path, *, max_students: int = 0, rebuild: bool = False
) -> pd.DataFrame:
    """(student_id, as_of, 11 features, label) for one school, with an on-disk cache."""
    cache = DATA_DIR / f"supervised_{xlsx_path.stem}.pkl"
    key = _cache_key(xlsx_path, max_students)
    if cache.exists() and not rebuild:
        blob = pd.read_pickle(cache)
        if blob.get("key") == key:
            table = blob["table"]
            print(f"  [cache] {cache.name}: {len(table):,} samples")
            return table

    events = load_daily_attendance(xlsx_path)
    calendar = load_calendar(xlsx_path)
    term_bounds = load_term_bounds(xlsx_path)
    reasons_by_student = load_absence_reasons(xlsx_path)
    if max_students:
        keep = sorted(events["student_id"].unique())[:max_students]
        events = events[events["student_id"].isin(keep)].reset_index(drop=True)
        reasons_by_student = {k: v for k, v in reasons_by_student.items() if k in set(keep)}

    print(
        f"  {xlsx_path.name}: {len(events):,} events, "
        f"{events['student_id'].nunique():,} students, "
        f"{events.attrs.get('dropped_unmapped_status', 0):,} rows dropped (bad status); "
        f"calendar {len(calendar):,} school days "
        f"({calendar.first_day} .. {calendar.last_day}); "
        f"{len(term_bounds)} terms; "
        f"{sum(len(v) for v in reasons_by_student.values()):,} categorised absence reasons "
        f"({len(reasons_by_student):,} students)"
    )

    t0 = time.time()
    table = build_training_table(
        events,
        calendar,
        step_days=FEATURE_BUILD_STEP_DAYS,
        threshold=PERSISTENT_ABSENCE_THRESHOLD,
        drop_unlabelled=True,
        reasons_by_student=reasons_by_student,
        term_bounds=term_bounds,
    )
    table = _drop_out_of_enrolment(table, events)
    table = table.dropna(subset=[LABEL_NAME]).reset_index(drop=True)
    print(
        f"  built {len(table):,} labelled samples in {time.time() - t0:.0f}s "
        f"(positive rate {table[LABEL_NAME].mean():.3f})"
    )

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    pd.to_pickle({"key": key, "table": table}, cache)
    return table


# --------------------------------------------------------------------------- #
# Models                                                                      #
# --------------------------------------------------------------------------- #


def make_random_forest() -> Pipeline:
    """Primary model. Median-impute the (occasionally nan) rate features, then RF."""
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median")),
            (
                "rf",
                RandomForestClassifier(
                    n_estimators=300,
                    max_depth=None,
                    min_samples_leaf=5,
                    class_weight="balanced",
                    random_state=SEED,
                    n_jobs=-1,
                ),
            ),
        ]
    )


def make_logistic_regression() -> Pipeline:
    """Linear baseline. Impute -> standardise -> logistic regression."""
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            (
                "logreg",
                LogisticRegression(
                    max_iter=1000,
                    class_weight="balanced",
                    random_state=SEED,
                ),
            ),
        ]
    )


class RuleBasedScorer:
    """Transparent weighted-risk baseline - no learning.

    Risk score on [0, 1] from four of the engineered features:

        score = 0.40 * consecutive   min(longest_absence_streak / 5, 1)
              + 0.30 * monthly_rate  1 - mean(attendance_rate_w1, attendance_rate_w2)
              + 0.15 * day_of_week   dow_concentration
              + 0.15 * trend         max(0, -attendance_trend), capped at 1

    The consecutive ramp reaches 1.0 at 5 absences - the same point the hard
    override forces red.

    Flag:
        red    if score >= 0.60  OR  longest_absence_streak >= 5   (hard override)
        amber  if score >= 0.35
        green  otherwise

    Binary prediction = 1 when the flag is amber or red. For AUC, an overridden
    sample is scored 1.0 so it ranks above every non-overridden one.

    Missing rate features are read as "attended" (1.0) and missing counts as 0 -
    a holiday-only window should not look risky.
    """

    WEIGHTS = {"consecutive": 0.40, "monthly_rate": 0.30, "day_of_week": 0.15, "trend": 0.15}
    CONSECUTIVE_NORM = 5.0
    AMBER_THRESHOLD = 0.35
    RED_THRESHOLD = 0.60
    OVERRIDE_STREAK = 5
    POSITIVE_FLAGS = ("amber", "red")

    def fit(self, X, y=None):  # noqa: D401 - sklearn-style no-op
        self.train_positive_rate_ = None if y is None else float(np.mean(np.asarray(y)))
        return self

    @classmethod
    def describe(cls) -> dict:
        return {
            "weights": cls.WEIGHTS,
            "consecutive_norm_days": cls.CONSECUTIVE_NORM,
            "amber_threshold": cls.AMBER_THRESHOLD,
            "red_threshold": cls.RED_THRESHOLD,
            "override_consecutive_absences": cls.OVERRIDE_STREAK,
            "positive_flags": list(cls.POSITIVE_FLAGS),
        }

    def _frame(self, X) -> pd.DataFrame:
        if isinstance(X, pd.DataFrame):
            return X
        return pd.DataFrame(np.asarray(X), columns=list(FEATURE_NAMES))

    def _score_and_override(self, X):
        df = self._frame(X)
        rate = lambda col: np.nan_to_num(df[col].to_numpy(dtype=float), nan=1.0)
        cnt = lambda col: np.nan_to_num(df[col].to_numpy(dtype=float), nan=0.0)

        streak = cnt("longest_absence_streak")
        consecutive = np.clip(streak / self.CONSECUTIVE_NORM, 0.0, 1.0)
        monthly_rate = np.clip(
            1.0 - (rate("attendance_rate_w1") + rate("attendance_rate_w2")) / 2.0, 0.0, 1.0
        )
        day_of_week = np.clip(cnt("dow_concentration"), 0.0, 1.0)
        trend = np.clip(-cnt("attendance_trend"), 0.0, 1.0)

        score = (
            self.WEIGHTS["consecutive"] * consecutive
            + self.WEIGHTS["monthly_rate"] * monthly_rate
            + self.WEIGHTS["day_of_week"] * day_of_week
            + self.WEIGHTS["trend"] * trend
        )
        override = streak >= self.OVERRIDE_STREAK
        return score, override

    def flags(self, X) -> np.ndarray:
        score, override = self._score_and_override(X)
        out = np.full(len(score), "green", dtype=object)
        out[score >= self.AMBER_THRESHOLD] = "amber"
        out[(score >= self.RED_THRESHOLD) | override] = "red"
        return out

    def predict(self, X) -> np.ndarray:
        flags = self.flags(X)
        return np.isin(flags, self.POSITIVE_FLAGS).astype(int)

    def predict_proba(self, X) -> np.ndarray:
        score, override = self._score_and_override(X)
        pos = np.clip(np.where(override, 1.0, score), 0.0, 1.0)
        return np.column_stack([1.0 - pos, pos])


# --------------------------------------------------------------------------- #
# Evaluation + reporting                                                      #
# --------------------------------------------------------------------------- #


def evaluate(y_true, y_score, y_pred) -> dict:
    y_true = np.asarray(y_true, dtype=int)
    y_pred = np.asarray(y_pred, dtype=int)
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_true, y_pred, average="binary", pos_label=1, zero_division=0
    )
    try:
        auc = float(roc_auc_score(y_true, y_score))
    except ValueError:  # only one class present in y_true
        auc = None
    cm = confusion_matrix(y_true, y_pred, labels=[0, 1])
    return {
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(f1),
        "auc_roc": auc,
        "confusion_matrix": {
            "tn": int(cm[0, 0]),
            "fp": int(cm[0, 1]),
            "fn": int(cm[1, 0]),
            "tp": int(cm[1, 1]),
        },
        "support": {
            "n": int(y_true.size),
            "positives": int(y_true.sum()),
            "negatives": int((y_true == 0).sum()),
        },
    }


def _dataset_stats(table: pd.DataFrame) -> dict:
    as_of = pd.to_datetime(table["as_of"])
    return {
        "n_samples": int(len(table)),
        "n_students": int(table["student_id"].nunique()),
        "date_range": [as_of.min().date().isoformat(), as_of.max().date().isoformat()],
        "positives": int(table[LABEL_NAME].sum()),
        "positive_rate": float(table[LABEL_NAME].mean()),
    }


def _xy(table: pd.DataFrame):
    X = table[list(FEATURE_NAMES)].astype(float).reset_index(drop=True)
    y = table[LABEL_NAME].astype(int).reset_index(drop=True)
    return X, y


MODEL_LABELS = {
    "random_forest": "Random Forest",
    "logistic_regression": "Logistic Regression",
    "rule_based": "Rule-based",
}
EVAL_LABELS = {
    "sch01_test": "SCH-01 test (temporal)",
    "sch02_holdout": "SCH-02 (unseen school)",
}


def _print_comparison(report: dict) -> None:
    def fmt(v):
        return " n/a " if v is None else f"{v:5.3f}"

    header = (
        f"{'Model':<20} {'Eval set':<24} "
        f"{'Prec':>6} {'Recall':>7} {'F1':>6} {'AUC':>6}   "
        f"{'TN':>6} {'FP':>6} {'FN':>6} {'TP':>6}"
    )
    print("\n" + "=" * len(header))
    print("MODEL COMPARISON  (positive class = persistent_absenteeism)")
    print("=" * len(header))
    print(header)
    print("-" * len(header))
    for model_key, entry in report["models"].items():
        for eval_key in EVAL_LABELS:
            m = entry[eval_key]
            cm = m["confusion_matrix"]
            print(
                f"{MODEL_LABELS[model_key]:<20} {EVAL_LABELS[eval_key]:<24} "
                f"{fmt(m['precision'])} {fmt(m['recall']):>7} {fmt(m['f1'])} {fmt(m['auc_roc'])}   "
                f"{cm['tn']:>6} {cm['fp']:>6} {cm['fn']:>6} {cm['tp']:>6}"
            )
        print("-" * len(header))

    print("\nDatasets")
    for name, s in report["datasets"].items():
        print(
            f"  {name:<14} {s['n_samples']:>7,} samples  {s['n_students']:>4} students  "
            f"{s['date_range'][0]} .. {s['date_range'][1]}  "
            f"pos={s['positive_rate']:.3f}"
        )
    fi = report["models"]["random_forest"].get("feature_importances", {})
    if fi:
        print("\nRandom Forest feature importance")
        for feat, imp in sorted(fi.items(), key=lambda kv: -kv[1]):
            print(f"  {feat:<24} {imp:.3f}")


# --------------------------------------------------------------------------- #
# Orchestration                                                               #
# --------------------------------------------------------------------------- #


def _locate(prefix: str) -> Path:
    for base in (DATA_DIR, REPO_ROOT):
        hits = sorted(base.glob(f"{prefix}*.xlsx"))
        if hits:
            return hits[0]
    sys.exit(f"could not find {prefix}*.xlsx in {DATA_DIR} or {REPO_ROOT}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--sch01", type=Path, help="path to the SCH-01 xlsx (default: auto-locate)")
    ap.add_argument("--sch02", type=Path, help="path to the SCH-02 xlsx (default: auto-locate)")
    ap.add_argument(
        "--rebuild", action="store_true", help="ignore cached supervised tables, rebuild from xlsx"
    )
    ap.add_argument(
        "--max-students", type=int, default=0, help="cap students per school for a fast dry run"
    )
    args = ap.parse_args(argv)

    sch01_path = args.sch01 or _locate("SCH-01")
    sch02_path = args.sch02 or _locate("SCH-02")

    print("Building supervised tables (first run is slow: ~350k-450k rows/school)")
    table01 = supervised_table(sch01_path, max_students=args.max_students, rebuild=args.rebuild)
    table02 = supervised_table(sch02_path, max_students=args.max_students, rebuild=args.rebuild)
    if table01.empty or table02.empty:
        sys.exit("no labelled samples produced - check the data files")

    # SCH-01: strict temporal split, gap = label horizon so no training row's
    # forward window crosses the boundary. SCH-02 stays fully held out.
    train01, test01 = temporal_train_test_split(
        table01, test_size=TEST_SIZE, date_col="as_of", gap=LABEL_HORIZON_DAYS
    )
    if train01.empty or test01.empty:
        sys.exit("temporal split produced an empty side - not enough distinct SCH-01 dates")
    boundary = pd.to_datetime(test01["as_of"]).min()
    assert pd.to_datetime(train01["as_of"]).max() < boundary, "temporal leak: train reaches test"
    print(
        f"\nSCH-01 temporal split @ {boundary.date()}: "
        f"train {len(train01):,} (<= {pd.to_datetime(train01['as_of']).max().date()}), "
        f"test {len(test01):,} (>= {boundary.date()})"
    )

    X_train, y_train = _xy(train01)
    if y_train.nunique() < 2:
        sys.exit("SCH-01 training split has a single label class")

    eval_sets = {"sch01_test": _xy(test01), "sch02_holdout": _xy(table02)}

    models = {
        "random_forest": make_random_forest(),
        "logistic_regression": make_logistic_regression(),
        "rule_based": RuleBasedScorer(),
    }

    report = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "config": {
            "seed": SEED,
            "label": LABEL_NAME,
            "persistent_absence_threshold": PERSISTENT_ABSENCE_THRESHOLD,
            "label_horizon_days": LABEL_HORIZON_DAYS,
            "feature_build_step_days": FEATURE_BUILD_STEP_DAYS,
            "temporal_test_size": TEST_SIZE,
            "temporal_gap_days": LABEL_HORIZON_DAYS,
            "enrolment_margin_days": ENROLMENT_MARGIN_DAYS,
            "features": list(FEATURE_NAMES),
            "sch01_split_boundary": boundary.date().isoformat(),
            "train_school": "SCH-01",
            "holdout_school": "SCH-02",
        },
        "datasets": {
            "sch01_train": _dataset_stats(train01),
            "sch01_test": _dataset_stats(test01),
            "sch02_holdout": _dataset_stats(table02),
        },
        "models": {},
    }

    for name, model in models.items():
        print(f"\nfitting {MODEL_LABELS[name]} on {len(X_train):,} SCH-01 training samples")
        model.fit(X_train, y_train)

        entry: dict = {}
        if name == "random_forest":
            rf = model.named_steps["rf"]
            entry["params"] = {
                k: rf.get_params()[k]
                for k in ("n_estimators", "max_depth", "min_samples_leaf", "class_weight", "random_state")
            }
            entry["feature_importances"] = {
                f: float(w) for f, w in zip(FEATURE_NAMES, rf.feature_importances_)
            }
        elif name == "logistic_regression":
            lr = model.named_steps["logreg"]
            entry["coefficients"] = {
                f: float(w) for f, w in zip(FEATURE_NAMES, lr.coef_[0])
            }
            entry["intercept"] = float(lr.intercept_[0])
        elif name == "rule_based":
            entry["scheme"] = RuleBasedScorer.describe()

        for set_name, (X_eval, y_eval) in eval_sets.items():
            proba = model.predict_proba(X_eval)[:, 1]
            pred = model.predict(X_eval)
            entry[set_name] = evaluate(y_eval, proba, pred)
        report["models"][name] = entry

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    rf_path = MODELS_DIR / "rf_model.pkl"
    report_path = RESULTS_DIR / "evaluation_report.json"
    joblib.dump(models["random_forest"], rf_path)  # full pipeline: imputer + RF
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    _print_comparison(report)
    print(f"\nsaved model  -> {rf_path.relative_to(REPO_ROOT)}")
    print(f"saved report -> {report_path.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
