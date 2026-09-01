"""Unit tests for the SmartAttend AI feature-engineering pipeline.

Covers feature_engineering, compute_labels and temporal_split. Run with:

    cd ml && ./venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from feature_engineering import (
    FEATURE_NAMES,
    KENYA_SCHOOL_CALENDAR as CAL,
    SchoolCalendar,
    _as_date,
    attendance_rate,
    compute_features,
    normalise_records,
)
from compute_labels import (
    LABEL_NAME,
    absence_rate_in_window,
    build_training_table,
    compute_label,
    generate_reference_dates,
)
from temporal_split import (
    ForwardChainingCV,
    forward_chaining_indices,
    temporal_train_test_split,
)

# A clean stretch of Term 1 2026 with no holidays: 5 school days every week.
AS_OF = date(2026, 2, 16)          # Monday
HISTORY_START = date(2026, 1, 5)   # Term 1 opens (Monday)
LABEL_END = date(2026, 3, 16)


def records(pattern, start=HISTORY_START, end=LABEL_END, student="s1", calendar=CAL):
    """Build event dicts by applying ``pattern(day) -> status | None`` to every
    school day in ``[start, end)``."""
    out = []
    day = _as_date(start)
    end = _as_date(end)
    while day < end:
        if calendar.is_school_day(day):
            status = pattern(day)
            if status is not None:
                out.append({"studentId": student, "date": day.isoformat(), "status": status})
        day += timedelta(days=1)
    return out


ALWAYS_PRESENT = lambda d: "present"
ALWAYS_ABSENT = lambda d: "absent"
MONDAY_ABSENT = lambda d: "absent" if d.weekday() == 0 else "present"


# --------------------------------------------------------------------------- #
# Calendar                                                                    #
# --------------------------------------------------------------------------- #


def test_calendar_loads_three_terms_from_json():
    assert len(CAL.terms) == 3
    names = [name for name, _, _ in CAL.terms]
    assert names == ["Term 1 2026", "Term 2 2026", "Term 3 2026"]


def test_calendar_excludes_weekends_and_holidays():
    assert CAL.is_school_day(date(2026, 1, 6))       # ordinary Tuesday
    assert not CAL.is_school_day(date(2026, 1, 10))  # Saturday
    assert not CAL.is_school_day(date(2026, 1, 11))  # Sunday
    assert not CAL.is_school_day(date(2026, 4, 3))   # Good Friday + Term 1 close
    assert not CAL.is_school_day(date(2026, 6, 1))   # Madaraka Day
    assert not CAL.is_school_day(date(2026, 4, 20))  # between Term 1 and Term 2


def test_calendar_week_has_five_school_days_in_clean_stretch():
    assert CAL.count_school_days(date(2026, 2, 2), date(2026, 2, 9)) == 5
    assert CAL.count_school_days(date(2026, 2, 2), date(2026, 2, 16)) == 10


# --------------------------------------------------------------------------- #
# Feature computation - the required scenarios                                #
# --------------------------------------------------------------------------- #


def test_normal_attendance_is_all_ones_and_zeros():
    feats = compute_features(records(ALWAYS_PRESENT), AS_OF)
    assert feats["attendance_rate_w1"] == 1.0
    assert feats["attendance_rate_w2"] == 1.0
    assert feats["attendance_rate_w3"] == 1.0
    assert feats["longest_absence_streak"] == 0.0
    assert feats["absence_episode_count"] == 0.0
    assert feats["dow_concentration"] == 0.0
    assert feats["attendance_trend"] == 0.0


def test_chronic_absenteeism():
    feats = compute_features(records(ALWAYS_ABSENT), AS_OF)
    assert feats["attendance_rate_w1"] == 0.0
    assert feats["attendance_rate_w2"] == 0.0
    assert feats["attendance_rate_w3"] == 0.0
    # 4-week window is 20 school days, all absent, one unbroken episode.
    assert feats["longest_absence_streak"] == 20.0
    assert feats["absence_episode_count"] == 1.0
    # 4 absences on each of 5 weekdays -> 4 / 20.
    assert feats["dow_concentration"] == pytest.approx(0.2)
    assert feats["attendance_trend"] == 0.0


def test_monday_barrier_pattern():
    feats = compute_features(records(MONDAY_ABSENT), AS_OF)
    # One Monday missing per 5-day window -> 0.8 attendance, flat trend.
    assert feats["attendance_rate_w1"] == pytest.approx(0.8)
    assert feats["attendance_rate_w2"] == pytest.approx(0.8)
    assert feats["attendance_rate_w3"] == pytest.approx(0.8)
    assert feats["attendance_trend"] == pytest.approx(0.0)
    # Four isolated Mondays in the 4-week window.
    assert feats["longest_absence_streak"] == 1.0
    assert feats["absence_episode_count"] == 4.0
    # Every absence lands on the same weekday.
    assert feats["dow_concentration"] == pytest.approx(1.0)


def test_term_start_absence():
    # Absent the first fortnight of term, present thereafter; evaluate once the
    # student has been back for two weeks.
    def pattern(d):
        return "absent" if d < date(2026, 1, 19) else "present"

    feats = compute_features(records(pattern), date(2026, 2, 2))
    assert feats["attendance_rate_w1"] == 1.0                 # [Jan19, Feb2) back at school
    assert feats["attendance_rate_w2"] == 0.0                 # [Jan5, Jan19) absent
    assert math.isnan(feats["attendance_rate_w3"])            # [Dec22, Jan5) pre-term, no school days
    assert feats["longest_absence_streak"] == 10.0            # first 10 school days
    assert feats["absence_episode_count"] == 1.0
    assert feats["attendance_trend"] == pytest.approx(1.0)    # w1 - w2


# --------------------------------------------------------------------------- #
# Feature computation - edge cases                                            #
# --------------------------------------------------------------------------- #


def test_empty_records_are_treated_as_all_absent():
    feats = compute_features([], AS_OF)
    assert set(feats) == set(FEATURE_NAMES)
    assert feats["attendance_rate_w1"] == 0.0
    assert feats["attendance_rate_w2"] == 0.0
    assert feats["attendance_rate_w3"] == 0.0
    assert feats["longest_absence_streak"] == 20.0
    assert feats["absence_episode_count"] == 1.0
    assert feats["attendance_trend"] == 0.0


def test_window_with_no_school_days_yields_nan_rate():
    # 2026-04-20 sits in the holiday gap between Term 1 and Term 2.
    feats = compute_features(records(ALWAYS_PRESENT), date(2026, 4, 20))
    assert math.isnan(feats["attendance_rate_w1"])   # [Apr6, Apr20): no school days
    assert math.isnan(feats["attendance_trend"])     # depends on w1
    # Counts still resolve to finite numbers.
    assert feats["longest_absence_streak"] >= 0.0
    assert feats["absence_episode_count"] >= 0.0
    assert 0.0 <= feats["dow_concentration"] <= 1.0


def test_records_on_non_school_days_are_ignored():
    recs = records(ALWAYS_PRESENT)
    recs.append({"studentId": "s1", "date": "2026-02-14", "status": "absent"})  # a Saturday
    feats = compute_features(recs, AS_OF)
    assert feats["attendance_rate_w1"] == 1.0
    assert feats["longest_absence_streak"] == 0.0


def test_no_future_records_used():
    past = records(ALWAYS_PRESENT, start=HISTORY_START, end=AS_OF)
    future_absences = records(ALWAYS_ABSENT, start=AS_OF, end=LABEL_END)
    assert compute_features(past, AS_OF) == compute_features(past + future_absences, AS_OF)


def test_as_of_day_itself_is_excluded():
    recs = records(ALWAYS_PRESENT, end=AS_OF)
    recs.append({"studentId": "s1", "date": AS_OF.isoformat(), "status": "absent"})
    assert compute_features(recs, AS_OF)["attendance_rate_w1"] == 1.0


def test_later_createdAt_wins_on_conflicting_rows():
    recs = [
        {"studentId": "s1", "date": "2026-02-10", "status": "absent", "createdAt": "2026-02-10T08:00"},
        {"studentId": "s1", "date": "2026-02-10", "status": "present", "createdAt": "2026-02-10T15:00"},
    ]
    by_day = normalise_records(recs, CAL)
    assert by_day[date(2026, 2, 10)] == "present"


def test_dow_concentration_bounds():
    even = compute_features(records(ALWAYS_ABSENT), AS_OF)["dow_concentration"]
    assert even == pytest.approx(0.2)          # 1 / 5 weekdays
    one_day = compute_features(records(MONDAY_ABSENT), AS_OF)["dow_concentration"]
    assert one_day == pytest.approx(1.0)


def test_attendance_rate_helper_direct():
    by_day = normalise_records(records(ALWAYS_PRESENT), CAL)
    assert attendance_rate(by_day, CAL, date(2026, 2, 2), date(2026, 2, 16)) == 1.0
    assert math.isnan(attendance_rate(by_day, CAL, date(2026, 4, 6), date(2026, 4, 20)))


# --------------------------------------------------------------------------- #
# Labels                                                                      #
# --------------------------------------------------------------------------- #


def test_label_is_one_for_chronic_absentee():
    assert compute_label(records(ALWAYS_ABSENT), AS_OF) == 1.0


def test_label_is_zero_for_regular_attender():
    assert compute_label(records(ALWAYS_PRESENT), AS_OF) == 0.0


def test_label_is_zero_for_monday_barrier_alone():
    # 4 missed of 20 school days ahead = 20% absence, below the 30% threshold.
    assert compute_label(records(MONDAY_ABSENT), AS_OF) == 0.0


def test_label_threshold_is_inclusive_at_30_percent():
    # Forward window [Feb16, Mar16) has 20 school days. Miss exactly 6 -> 0.30.
    school_days_ahead = CAL.school_days(AS_OF, AS_OF + timedelta(days=28))
    assert len(school_days_ahead) == 20
    miss_six = set(school_days_ahead[:6])
    recs = records(lambda d: "absent" if d in miss_six else "present",
                   start=AS_OF, end=date(2026, 3, 20))
    assert absence_rate_in_window(recs, AS_OF, AS_OF + timedelta(days=28)) == pytest.approx(0.30)
    assert compute_label(recs, AS_OF) == 1.0

    miss_five = set(school_days_ahead[:5])
    recs5 = records(lambda d: "absent" if d in miss_five else "present",
                    start=AS_OF, end=date(2026, 3, 20))
    assert compute_label(recs5, AS_OF) == 0.0


def test_label_is_nan_when_no_school_days_ahead():
    # Term 3 closes 2026-12-04; nothing scheduled in the four weeks after.
    assert math.isnan(compute_label(records(ALWAYS_PRESENT, end=date(2026, 12, 4)),
                                    date(2026, 12, 7)))


def test_label_uses_only_forward_window():
    past_absences = records(ALWAYS_ABSENT, start=HISTORY_START, end=AS_OF)
    future_present = records(ALWAYS_PRESENT, start=AS_OF, end=LABEL_END)
    assert compute_label(past_absences + future_present, AS_OF) == 0.0


# --------------------------------------------------------------------------- #
# Dataset assembly                                                            #
# --------------------------------------------------------------------------- #


def test_build_training_table_shape_and_columns():
    # Records must span every forward label window, so extend past the last
    # reference date's four-week horizon.
    events = (
        records(ALWAYS_PRESENT, student="regular", end=date(2026, 4, 4))
        + records(ALWAYS_ABSENT, student="chronic", end=date(2026, 4, 4))
    )
    ref_dates = [date(2026, 2, 2), date(2026, 2, 16), date(2026, 3, 2)]
    table = build_training_table(events, CAL, reference_dates=ref_dates)

    assert list(table.columns) == ["student_id", "as_of", *FEATURE_NAMES, LABEL_NAME]
    assert set(table["student_id"]) == {"regular", "chronic"}
    assert (table.loc[table["student_id"] == "chronic", LABEL_NAME] == 1.0).all()
    assert (table.loc[table["student_id"] == "regular", LABEL_NAME] == 0.0).all()
    # sorted by time
    assert table["as_of"].is_monotonic_increasing


def test_build_training_table_empty_input():
    table = build_training_table([], CAL)
    assert list(table.columns) == ["student_id", "as_of", *FEATURE_NAMES, LABEL_NAME]
    assert len(table) == 0


def test_generate_reference_dates_leaves_room_both_sides():
    dates = generate_reference_dates(CAL, step_days=14)
    assert dates[0] >= CAL.first_day + timedelta(days=28)
    assert dates[-1] <= CAL.last_day - timedelta(days=28)
    assert all(b - a == timedelta(days=14) for a, b in zip(dates, dates[1:]))


# --------------------------------------------------------------------------- #
# Temporal split                                                              #
# --------------------------------------------------------------------------- #


@pytest.fixture
def windowed_table():
    events = []
    for i in range(6):
        events += records(ALWAYS_PRESENT, student=f"s{i}")
    ref_dates = [date(2026, 1, 19) + timedelta(days=7 * k) for k in range(10)]
    return build_training_table(events, CAL, reference_dates=ref_dates, drop_unlabelled=False)


def test_temporal_split_keeps_train_before_test(windowed_table):
    train, test = temporal_train_test_split(windowed_table, test_size=0.3, date_col="as_of")
    assert len(train) > 0 and len(test) > 0
    assert train["as_of"].max() < test["as_of"].min()
    assert len(train) + len(test) == len(windowed_table)


def test_temporal_split_with_explicit_cutoff(windowed_table):
    cutoff = date(2026, 2, 16)
    train, test = temporal_train_test_split(windowed_table, date_col="as_of", cutoff=cutoff)
    assert train["as_of"].max() < cutoff
    assert test["as_of"].min() >= cutoff


def test_temporal_split_gap_drops_boundary_rows(windowed_table):
    train_no_gap, _ = temporal_train_test_split(windowed_table, test_size=0.3, date_col="as_of")
    train_gap, _ = temporal_train_test_split(windowed_table, test_size=0.3, date_col="as_of", gap=14)
    assert len(train_gap) < len(train_no_gap)


def test_temporal_split_does_not_shuffle(windowed_table):
    train, _ = temporal_train_test_split(windowed_table, test_size=0.3, date_col="as_of")
    assert train["as_of"].is_monotonic_increasing


# --------------------------------------------------------------------------- #
# Forward-chaining cross-validation                                           #
# --------------------------------------------------------------------------- #


def test_forward_chaining_yields_requested_number_of_folds():
    dates = pd.to_datetime(pd.date_range("2026-01-19", periods=60, freq="3D")).repeat(2)
    folds = forward_chaining_indices(dates, n_splits=5)
    assert len(folds) == 5
    assert ForwardChainingCV(n_splits=5).get_n_splits() == 5


def test_forward_chaining_folds_are_strictly_ordered_and_expanding():
    dates = np.array(sorted(pd.date_range("2026-01-19", periods=48, freq="4D").tolist() * 2))
    folds = forward_chaining_indices(dates, n_splits=4)
    prev_train_size = -1
    for train_idx, test_idx in folds:
        assert dates[train_idx].max() < dates[test_idx].min()   # no leakage
        assert len(train_idx) > prev_train_size                 # expanding window
        prev_train_size = len(train_idx)


def test_forward_chaining_gap_removes_overlapping_training_rows():
    dates = np.array(sorted(pd.date_range("2026-01-19", periods=48, freq="4D").tolist() * 2))
    no_gap = forward_chaining_indices(dates, n_splits=4, gap=0)
    with_gap = forward_chaining_indices(dates, n_splits=4, gap=timedelta(days=20))
    assert sum(len(tr) for tr, _ in with_gap) < sum(len(tr) for tr, _ in no_gap)


def test_forward_chaining_is_sklearn_compatible():
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.model_selection import cross_val_score

    table_dates = pd.date_range("2026-01-19", periods=40, freq="5D")
    df = pd.DataFrame(
        {
            "as_of": table_dates.repeat(4),
            "f1": np.random.default_rng(0).normal(size=160),
            "y": np.tile([0, 1], 80),
        }
    )
    cv = ForwardChainingCV(n_splits=4)
    scores = cross_val_score(
        RandomForestClassifier(n_estimators=10, random_state=0),
        df[["f1"]], df["y"], cv=cv.split(df[["f1"]], df["y"], groups=df["as_of"]),
    )
    assert len(scores) == 4


def test_custom_calendar_from_dict():
    tiny = SchoolCalendar.from_dict(
        {
            "name": "tiny",
            "terms": [{"name": "t", "start": "2026-01-05", "end": "2026-01-30"}],
            "public_holidays": [{"date": "2026-01-07", "name": "made up"}],
            "weekend_weekdays": [5, 6],
        }
    )
    assert len(tiny) == 20 - 1                       # 4 weeks Mon-Fri minus one holiday
    assert not tiny.is_school_day(date(2026, 1, 7))
    assert tiny.is_school_day(date(2026, 1, 6))
