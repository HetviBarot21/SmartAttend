"""Feature engineering for the SmartAttend AI persistent-absenteeism model.

Target model: a classifier that predicts **persistent absenteeism** - a
student missing >= 30% of scheduled school days inside a rolling four-week
window (label built in :mod:`compute_labels`).

This module turns raw attendance events into the **eleven-feature** vector the
classifier consumes (see :data:`FEATURE_NAMES`). Every calculation runs on the
*school-day axis* from the Kenya school term calendar (``kenya_calendar.json``):
weekends, public holidays and any day outside a term are not scheduled school
days and are never counted. A dated attendance record that does not land on a
scheduled school day is ignored outright.

All features are computed for a reference date ``as_of`` using **only records
strictly before ``as_of``**:

1. ``attendance_rate_w1`` - attendance rate in the most recent two-week window
   ``[as_of - 14d, as_of)``.
2. ``attendance_rate_w2`` - attendance rate in the two-week window before that.
3. ``attendance_rate_w3`` - attendance rate in the two-week window before that.
4. ``longest_absence_streak`` - longest run of consecutive scheduled school days
   marked/left absent, within the current four-week window ``[as_of - 28d, as_of)``.
5. ``absence_episode_count`` - number of separate absence episodes (maximal runs
   of >= 1 absent school day) in the current four-week window.
6. ``dow_concentration`` - absences on the single most common absence weekday
   divided by total absences, within the current four-week window. 0.0 when
   there are no absences.
7. ``attendance_trend`` - ``attendance_rate_w1 - attendance_rate_w2`` (signed;
   positive = improving, negative = worsening).
8. ``fee_absence_rate`` - fraction of the current four-week window's absences
   whose recorded reason is fee/money-related (fee arrears, no bus fare, sent
   home for fees, ...). Needs ``reasons``; 0.0 when there are no absences or no
   reason data.
9. ``health_absence_rate`` - fraction of the current four-week window's
   absences whose recorded reason is health-related (illness, fever, clinic
   visit, ...). Same fallback as above.
10. ``attendance_rate_term`` - attendance rate since the start of the term
    containing ``as_of``, up to ``as_of``. Captures a longer, term-scoped
    baseline the 2-week windows can't see. ``nan`` without ``term_bounds`` or
    when ``as_of`` falls outside any term (a holiday).
11. ``days_into_term`` - scheduled school days from the start of that term up
    to ``as_of``. Low values flag a student still in the settling-in period at
    a new term. ``nan`` under the same conditions as above.

"Attendance" means a ``present`` or ``late`` record. A scheduled school day with
no record counts as an absence - a completed historical window is expected to be
fully recorded, and a genuine gap is treated conservatively for risk scoring.
An attendance rate is ``nan`` only when the window contains no scheduled school
days at all (e.g. it falls entirely in a holiday break).

``reasons`` and ``term_bounds`` are optional everywhere: omit them (the
default) and features 8-11 come back ``nan``, imputed the same way a
holiday-only rate window already is. This is what keeps the plain
``compute_features(records, as_of)`` call every existing test and the JS ports
use working unchanged.
"""

from __future__ import annotations

import datetime as dt
import json
from collections import Counter
from pathlib import Path
from typing import Iterable, Mapping, Sequence

import numpy as np
import pandas as pd

# --------------------------------------------------------------------------- #
# Status vocabulary - matches client/src/db/database.js ATTENDANCE_STATUSES    #
# --------------------------------------------------------------------------- #

PRESENT_STATUSES = frozenset({"present", "late"})
ABSENT_STATUSES = frozenset({"absent"})

TWO_WEEKS = dt.timedelta(days=14)
FOUR_WEEKS = dt.timedelta(days=28)

#: Absence fraction at or above which a four-week window is "persistent absenteeism".
PERSISTENT_ABSENCE_THRESHOLD = 0.30

FEATURE_NAMES: tuple[str, ...] = (
    "attendance_rate_w1",
    "attendance_rate_w2",
    "attendance_rate_w3",
    "longest_absence_streak",
    "absence_episode_count",
    "dow_concentration",
    "attendance_trend",
    "fee_absence_rate",
    "health_absence_rate",
    "attendance_rate_term",
    "days_into_term",
)

# --------------------------------------------------------------------------- #
# Absence-reason categorisation                                               #
#                                                                              #
# The raw `reason_note` free text (SCH-01/02 "Absence Reasons" sheet) uses a   #
# fixed vocabulary of ~20 phrases - not truly free text - so a keyword lookup  #
# is enough; no NLP needed. Two buckets are kept as features because they      #
# plausibly call for different follow-ups (a fee reminder vs a health check),  #
# which is the whole point of surfacing them to a teacher. Everything else     #
# (bereavement, transport, farm work, "unknown", missing) falls through        #
# uncounted rather than diluting either bucket.                                #
# --------------------------------------------------------------------------- #

_FEE_REASON_KEYWORDS = (
    "fee", "fees", "bus fare", "no bus", "transport",
)
_HEALTH_REASON_KEYWORDS = (
    "fever", "illness", "ill", "sick", "unwell", "malaria", "clinic", "medical", "hospital",
)


def categorize_reason(note) -> str | None:
    """One of 'fee', 'health', or None (anything else / missing / unrecognised)."""
    if note is None or (isinstance(note, float) and np.isnan(note)):
        return None
    text = str(note).strip().lower()
    if not text or text == "-":
        return None
    if any(kw in text for kw in _FEE_REASON_KEYWORDS):
        return "fee"
    if any(kw in text for kw in _HEALTH_REASON_KEYWORDS):
        return "health"
    return None

# --------------------------------------------------------------------------- #
# School calendar                                                             #
# --------------------------------------------------------------------------- #


def _as_date(value) -> dt.date:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, pd.Timestamp):
        return value.date()
    if isinstance(value, str):
        return dt.date.fromisoformat(value.strip()[:10])
    raise TypeError(f"unsupported date value: {value!r}")


class SchoolCalendar:
    """Ordered set of scheduled school days derived from terms, weekends and
    public holidays. The day list is materialised once and queries are O(log n)
    or O(1)."""

    def __init__(
        self,
        terms: Iterable[Mapping | tuple],
        public_holidays: Iterable = (),
        weekend_weekdays: Iterable[int] = (5, 6),
        name: str = "calendar",
    ) -> None:
        self.name = name
        self.weekend_weekdays = frozenset(int(w) for w in weekend_weekdays)

        parsed_terms: list[tuple[str, dt.date, dt.date]] = []
        for term in terms:
            if isinstance(term, Mapping):
                parsed_terms.append(
                    (term.get("name", "term"), _as_date(term["start"]), _as_date(term["end"]))
                )
            else:  # (name, start, end) or (start, end)
                if len(term) == 3:
                    parsed_terms.append((term[0], _as_date(term[1]), _as_date(term[2])))
                else:
                    parsed_terms.append(("term", _as_date(term[0]), _as_date(term[1])))
        self.terms = tuple(sorted(parsed_terms, key=lambda t: t[1]))

        holidays: set[dt.date] = set()
        for h in public_holidays:
            holidays.add(_as_date(h["date"] if isinstance(h, Mapping) else h))
        self.public_holidays = frozenset(holidays)

        self._days: tuple[dt.date, ...] = self._materialise()
        self._day_set = frozenset(self._days)

    # -- construction ---------------------------------------------------------

    def _materialise(self) -> tuple[dt.date, ...]:
        out: list[dt.date] = []
        for _, start, end in self.terms:
            day = start
            while day <= end:
                if (
                    day.weekday() not in self.weekend_weekdays
                    and day not in self.public_holidays
                ):
                    out.append(day)
                day += dt.timedelta(days=1)
        return tuple(sorted(set(out)))

    @classmethod
    def from_json(cls, path: str | Path) -> "SchoolCalendar":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(
            terms=data["terms"],
            public_holidays=data.get("public_holidays", ()),
            weekend_weekdays=data.get("weekend_weekdays", (5, 6)),
            name=f"{data.get('country', 'calendar')}-{data.get('year', '')}".strip("-"),
        )

    @classmethod
    def from_dict(cls, data: Mapping) -> "SchoolCalendar":
        return cls(
            terms=data["terms"],
            public_holidays=data.get("public_holidays", ()),
            weekend_weekdays=data.get("weekend_weekdays", (5, 6)),
            name=data.get("name", "calendar"),
        )

    # -- queries ------------------------------------------------------------

    def __len__(self) -> int:
        return len(self._days)

    @property
    def first_day(self) -> dt.date:
        return self._days[0]

    @property
    def last_day(self) -> dt.date:
        return self._days[-1]

    def is_school_day(self, day) -> bool:
        return _as_date(day) in self._day_set

    def school_days(self, start, end) -> list[dt.date]:
        """Scheduled school days in the half-open interval ``[start, end)``."""
        start, end = _as_date(start), _as_date(end)
        return [d for d in self._days if start <= d < end]

    def count_school_days(self, start, end) -> int:
        return len(self.school_days(start, end))

    def all_days(self) -> tuple[dt.date, ...]:
        return self._days


# Default calendar: loaded from the JSON that ships next to this module.
_CALENDAR_PATH = Path(__file__).with_name("kenya_calendar.json")
KENYA_SCHOOL_CALENDAR = SchoolCalendar.from_json(_CALENDAR_PATH)

# --------------------------------------------------------------------------- #
# Record normalisation                                                        #
# --------------------------------------------------------------------------- #

_STUDENT_KEYS = ("student_id", "studentId", "studentID", "student")
_DATE_KEYS = ("date", "day", "attendance_date")
_STATUS_KEYS = ("status", "attendance_status", "state")


def _pick(row: Mapping, keys: Sequence[str]):
    for key in keys:
        if key in row and row[key] is not None:
            return row[key]
    return None


def normalise_records(
    records: Iterable[Mapping], calendar: SchoolCalendar
) -> dict[dt.date, str]:
    """Collapse raw event dicts to ``{school_day: status}``.

    Rows that do not fall on a scheduled school day are dropped. If two rows
    disagree for one day, the one with the later ``createdAt`` wins (falling
    back to last-seen).
    """
    chosen: dict[dt.date, tuple[str, str]] = {}
    for row in records:
        raw_date = _pick(row, _DATE_KEYS)
        raw_status = _pick(row, _STATUS_KEYS)
        if raw_date is None or raw_status is None:
            continue
        day = _as_date(raw_date)
        if not calendar.is_school_day(day):
            continue
        status = str(raw_status).strip().lower()
        tiebreak = str(row.get("createdAt") or row.get("created_at") or "")
        if day not in chosen or tiebreak >= chosen[day][1]:
            chosen[day] = (status, tiebreak)
    return {day: status for day, (status, _) in chosen.items()}


# --------------------------------------------------------------------------- #
# Window helpers                                                              #
# --------------------------------------------------------------------------- #


def _resolve_window(
    by_day: Mapping[dt.date, str],
    calendar: SchoolCalendar,
    start: dt.date,
    end: dt.date,
) -> list[tuple[dt.date, bool]]:
    """Every scheduled school day in ``[start, end)`` as ``(day, attended)``.

    A day with no record resolves to ``attended = False`` (absent).
    """
    resolved = []
    for day in calendar.school_days(start, end):
        status = by_day.get(day)
        resolved.append((day, status in PRESENT_STATUSES))
    return resolved


def attendance_rate(
    by_day: Mapping[dt.date, str],
    calendar: SchoolCalendar,
    start: dt.date,
    end: dt.date,
) -> float:
    """Fraction of scheduled school days in ``[start, end)`` the student attended.

    ``nan`` when the window contains no scheduled school days.
    """
    window = _resolve_window(by_day, calendar, start, end)
    if not window:
        return float("nan")
    attended = sum(1 for _, ok in window if ok)
    return attended / len(window)


def longest_absence_streak(window: Sequence[tuple[dt.date, bool]]) -> int:
    longest = current = 0
    for _, attended in window:
        if attended:
            current = 0
        else:
            current += 1
            longest = max(longest, current)
    return longest


def absence_episode_count(window: Sequence[tuple[dt.date, bool]]) -> int:
    episodes = 0
    in_episode = False
    for _, attended in window:
        if attended:
            in_episode = False
        elif not in_episode:
            episodes += 1
            in_episode = True
    return episodes


def dow_concentration(window: Sequence[tuple[dt.date, bool]]) -> float:
    """Absences on the most common absence weekday / total absences.

    Ranges from 1/k (absences spread evenly over k weekdays) to 1.0 (all on one
    weekday). 0.0 when there are no absences in the window.
    """
    absent_weekdays = [day.weekday() for day, attended in window if not attended]
    if not absent_weekdays:
        return 0.0
    counts = Counter(absent_weekdays)
    return max(counts.values()) / len(absent_weekdays)


def reason_absence_rate(
    window: Sequence[tuple[dt.date, bool]],
    reasons: Mapping[dt.date, str] | None,
    category: str,
) -> float:
    """Fraction of ``window``'s absences whose reason categorises as ``category``.

    0.0 when there are no absences in the window, or no reason data at all -
    same "nothing to see here" convention as :func:`dow_concentration`, not
    ``nan``, since an absence with an uncategorised reason is a real, known
    zero contribution to this bucket rather than a missing measurement.
    """
    absences = [day for day, attended in window if not attended]
    if not absences:
        return 0.0
    if not reasons:
        return 0.0
    hits = sum(1 for day in absences if reasons.get(day) == category)
    return hits / len(absences)


def _term_containing(
    term_bounds: Sequence[tuple[str, dt.date, dt.date]] | None, as_of: dt.date
) -> tuple[dt.date, dt.date] | None:
    if not term_bounds:
        return None
    for _, start, end in term_bounds:
        if start <= as_of <= end:
            return start, end
    return None


# --------------------------------------------------------------------------- #
# Public API                                                                  #
# --------------------------------------------------------------------------- #


def compute_features(
    records: Iterable[Mapping],
    as_of,
    calendar: SchoolCalendar = KENYA_SCHOOL_CALENDAR,
    reasons: Mapping[dt.date, str] | None = None,
    term_bounds: Sequence[tuple[str, dt.date, dt.date]] | None = None,
) -> dict[str, float]:
    """Eleven-feature vector for one student at reference date ``as_of``.

    Only records with ``date < as_of`` are used - no future or same-day
    information leaks into the features.

    Parameters
    ----------
    records
        Attendance event dicts for a single student. Keys may be camelCase or
        snake_case: ``date`` (ISO string / date), ``status``
        (``present`` / ``absent`` / ``late``), optional ``createdAt``.
    as_of
        Reference date (exclusive upper bound for feature windows).
    calendar
        School-day calendar; defaults to the Kenya 2026 calendar.
    reasons
        Optional ``{date: category}`` for this student's absence reasons,
        where ``category`` is whatever :func:`categorize_reason` returns
        (``'fee'`` / ``'health'`` / other). Omit to skip features 8-9 (nan).
    term_bounds
        Optional ``[(name, start, end), ...]`` term boundaries. Omit to skip
        features 10-11 (nan).

    Returns
    -------
    dict
        Keys exactly :data:`FEATURE_NAMES`. Rates and the trend may be ``nan``
        (window has no school days, or no term/reason data supplied); the
        counts are always integers-as-floats.
    """
    as_of = _as_date(as_of)
    by_day = {
        day: status
        for day, status in normalise_records(records, calendar).items()
        if day < as_of
    }

    w1_start, w2_start, w3_start = as_of - TWO_WEEKS, as_of - 2 * TWO_WEEKS, as_of - 3 * TWO_WEEKS
    four_week_start = as_of - FOUR_WEEKS

    rate_w1 = attendance_rate(by_day, calendar, w1_start, as_of)
    rate_w2 = attendance_rate(by_day, calendar, w2_start, w1_start)
    rate_w3 = attendance_rate(by_day, calendar, w3_start, w2_start)

    current4 = _resolve_window(by_day, calendar, four_week_start, as_of)

    trend = (
        float("nan")
        if (np.isnan(rate_w1) or np.isnan(rate_w2))
        else rate_w1 - rate_w2
    )

    term = _term_containing(term_bounds, as_of)
    if term is None:
        rate_term = float("nan")
        days_into_term = float("nan")
    else:
        term_start, _term_end = term
        rate_term = attendance_rate(by_day, calendar, term_start, as_of)
        days_into_term = float(calendar.count_school_days(term_start, as_of))

    return {
        "attendance_rate_w1": rate_w1,
        "attendance_rate_w2": rate_w2,
        "attendance_rate_w3": rate_w3,
        "longest_absence_streak": float(longest_absence_streak(current4)),
        "absence_episode_count": float(absence_episode_count(current4)),
        "dow_concentration": dow_concentration(current4),
        "attendance_trend": trend,
        "fee_absence_rate": reason_absence_rate(current4, reasons, "fee"),
        "health_absence_rate": reason_absence_rate(current4, reasons, "health"),
        "attendance_rate_term": rate_term,
        "days_into_term": days_into_term,
    }


def _columns(frame: pd.DataFrame) -> tuple[str, str, str]:
    def pick(keys):
        for key in keys:
            if key in frame.columns:
                return key
        raise KeyError(f"none of {keys} found in columns {list(frame.columns)}")

    return pick(_STUDENT_KEYS), pick(_DATE_KEYS), pick(_STATUS_KEYS)


def compute_features_frame(
    events,
    as_of,
    calendar: SchoolCalendar = KENYA_SCHOOL_CALENDAR,
) -> pd.DataFrame:
    """Feature matrix for every student in ``events`` at a single ``as_of`` date.

    ``events`` is a DataFrame (or iterable of row-dicts) carrying a student id,
    ``date`` and ``status``. Result is indexed by ``student_id`` with the
    :data:`FEATURE_NAMES` columns.
    """
    df = events if isinstance(events, pd.DataFrame) else pd.DataFrame(list(events))
    if df.empty:
        return pd.DataFrame(
            columns=list(FEATURE_NAMES), index=pd.Index([], name="student_id")
        )

    sid_col, date_col, status_col = _columns(df)
    has_created = "createdAt" in df.columns

    rows, index = [], []
    for student_id, group in df.groupby(sid_col, sort=True):
        recs = [
            {
                "date": r[date_col],
                "status": r[status_col],
                "createdAt": r["createdAt"] if has_created else None,
            }
            for _, r in group.iterrows()
        ]
        rows.append(compute_features(recs, as_of, calendar))
        index.append(student_id)

    return pd.DataFrame(rows, index=pd.Index(index, name="student_id"))[list(FEATURE_NAMES)]


if __name__ == "__main__":
    cal = KENYA_SCHOOL_CALENDAR
    print(f"{cal.name}: {len(cal)} scheduled school days")
    for name, start, end in cal.terms:
        print(f"  {name}: {cal.count_school_days(start, end + dt.timedelta(days=1))} days "
              f"({start} .. {end})")

    # Monday-barrier student: absent every Monday for six weeks, else present.
    events = []
    day = dt.date(2026, 1, 5)
    while day < dt.date(2026, 2, 20):
        if cal.is_school_day(day):
            status = "absent" if day.weekday() == 0 else "present"
            events.append({"studentId": "demo", "date": day.isoformat(), "status": status})
        day += dt.timedelta(days=1)

    feats = compute_features(events, as_of=dt.date(2026, 2, 20))
    print("\nMonday-barrier features @ 2026-02-20:")
    for key in FEATURE_NAMES:
        print(f"  {key:24s} {feats[key]:.4f}")
