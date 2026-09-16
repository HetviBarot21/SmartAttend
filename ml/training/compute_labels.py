"""Label computation for the SmartAttend AI persistent-absenteeism model.

The supervised target: for a student and a reference date ``as_of``, the label
is ``1`` if the student is projected to miss **>= 30% of scheduled school days
in the next four-week window** ``[as_of, as_of + 28d)``, and ``0`` otherwise.
This is the *outcome* the Random Forest is trained to predict from the
seven features in :mod:`feature_engineering`.

Labels look strictly forward; features (computed elsewhere) look strictly
backward. The two windows meet at ``as_of`` and never overlap, so there is no
leakage between X and y for a given sample.

A label is ``nan`` when the forward window contains no scheduled school days
(nothing to measure) - those samples must be dropped before training.
"""

from __future__ import annotations

import datetime as dt
from typing import Iterable, Mapping

import numpy as np
import pandas as pd

from feature_engineering import (
    FOUR_WEEKS,
    PERSISTENT_ABSENCE_THRESHOLD,
    KENYA_SCHOOL_CALENDAR,
    SchoolCalendar,
    _as_date,
    _resolve_window,
    compute_features,
    normalise_records,
)

LABEL_NAME = "persistent_absenteeism"


def absence_rate_in_window(
    records: Iterable[Mapping],
    start,
    end,
    calendar: SchoolCalendar = KENYA_SCHOOL_CALENDAR,
) -> float:
    """Fraction of scheduled school days in ``[start, end)`` the student missed.

    A scheduled school day with no ``present``/``late`` record counts as missed.
    ``nan`` when the window has no scheduled school days.
    """
    start, end = _as_date(start), _as_date(end)
    by_day = normalise_records(records, calendar)
    window = _resolve_window(by_day, calendar, start, end)
    if not window:
        return float("nan")
    missed = sum(1 for _, attended in window if not attended)
    return missed / len(window)


def compute_label(
    records: Iterable[Mapping],
    as_of,
    calendar: SchoolCalendar = KENYA_SCHOOL_CALENDAR,
    threshold: float = PERSISTENT_ABSENCE_THRESHOLD,
    horizon: dt.timedelta = FOUR_WEEKS,
) -> float:
    """Persistent-absenteeism label for one student at ``as_of``.

    Returns ``1.0`` if forward-window absence rate ``>= threshold``, ``0.0`` if
    below, ``nan`` if the forward window has no scheduled school days.
    """
    as_of = _as_date(as_of)
    rate = absence_rate_in_window(records, as_of, as_of + horizon, calendar)
    if np.isnan(rate):
        return float("nan")
    return 1.0 if rate >= threshold else 0.0


# --------------------------------------------------------------------------- #
# Dataset assembly                                                            #
# --------------------------------------------------------------------------- #


def generate_reference_dates(
    calendar: SchoolCalendar,
    step_days: int = 14,
    first: dt.date | None = None,
    last: dt.date | None = None,
    horizon: dt.timedelta = FOUR_WEEKS,
) -> list[dt.date]:
    """Reference (``as_of``) dates on a fixed cadence across the school year.

    The first date leaves room for a full four-week feature history behind it;
    the last leaves room for a full ``horizon`` label window ahead of it.
    """
    school_days = calendar.all_days()
    first = first or (school_days[0] + FOUR_WEEKS)
    last = last or (school_days[-1] - horizon)
    out, day = [], first
    while day <= last:
        out.append(day)
        day += dt.timedelta(days=step_days)
    return out


def build_training_table(
    events,
    calendar: SchoolCalendar = KENYA_SCHOOL_CALENDAR,
    step_days: int = 14,
    reference_dates: Iterable[dt.date] | None = None,
    threshold: float = PERSISTENT_ABSENCE_THRESHOLD,
    drop_unlabelled: bool = True,
    reasons_by_student: Mapping[object, Mapping[dt.date, str]] | None = None,
    term_bounds: list[tuple[str, dt.date, dt.date]] | None = None,
) -> pd.DataFrame:
    """Assemble the full supervised table: one row per (student, ``as_of``).

    Columns: ``student_id``, ``as_of``, the eleven :data:`FEATURE_NAMES`, and
    :data:`LABEL_NAME`. Rows whose forward window has no school days are dropped
    when ``drop_unlabelled`` is true. ``reasons_by_student`` and ``term_bounds``
    are optional and passed straight through to
    :func:`feature_engineering.compute_features` per student - omit both to get
    exactly the original seven-feature behaviour (the new four columns come
    back ``nan``, same as any other reference this pipeline had no data for).
    """
    from feature_engineering import FEATURE_NAMES, _columns

    reasons_by_student = reasons_by_student or {}

    df = events if isinstance(events, pd.DataFrame) else pd.DataFrame(list(events))
    if df.empty:
        cols = ["student_id", "as_of", *FEATURE_NAMES, LABEL_NAME]
        return pd.DataFrame(columns=cols)

    sid_col, date_col, status_col = _columns(df)
    has_created = "createdAt" in df.columns

    if reference_dates is None:
        reference_dates = generate_reference_dates(calendar, step_days=step_days)
    reference_dates = [_as_date(d) for d in reference_dates]

    per_student: dict = {}
    for student_id, group in df.groupby(sid_col, sort=True):
        per_student[student_id] = [
            {
                "date": r[date_col],
                "status": r[status_col],
                "createdAt": r["createdAt"] if has_created else None,
            }
            for _, r in group.iterrows()
        ]

    rows = []
    for student_id, recs in per_student.items():
        student_reasons = reasons_by_student.get(student_id)
        for as_of in reference_dates:
            label = compute_label(recs, as_of, calendar, threshold=threshold)
            if drop_unlabelled and np.isnan(label):
                continue
            feats = compute_features(
                recs, as_of, calendar, reasons=student_reasons, term_bounds=term_bounds
            )
            rows.append({"student_id": student_id, "as_of": as_of, **feats, LABEL_NAME: label})

    table = pd.DataFrame(rows)
    if not table.empty:
        table = table.sort_values(["as_of", "student_id"]).reset_index(drop=True)
    return table


if __name__ == "__main__":
    cal = KENYA_SCHOOL_CALENDAR

    # Chronic absentee vs. regular attender across Term 1.
    events = []
    day = cal.first_day
    while day <= dt.date(2026, 4, 3):
        if cal.is_school_day(day):
            events.append({"studentId": "regular", "date": day.isoformat(), "status": "present"})
            chronic = "absent" if (day.toordinal() % 3 == 0) else "present"
            events.append({"studentId": "chronic", "date": day.isoformat(), "status": chronic})
        day += dt.timedelta(days=1)

    # Reference dates confined to the span the synthetic records actually cover.
    ref_dates = [d for d in generate_reference_dates(cal, step_days=14)
                 if d <= dt.date(2026, 3, 6)]
    table = build_training_table(events, cal, reference_dates=ref_dates)
    print(table.to_string(index=False))
    print("\nlabel rate by student:")
    print(table.groupby("student_id")[LABEL_NAME].mean())
