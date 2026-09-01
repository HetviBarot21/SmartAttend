"""Time-aware data splitting for the SmartAttend AI absenteeism model.

Attendance is a time series, so the train/test split and the cross-validation
folds must respect chronology: a model is only useful if it predicts the
*future* from the *past*. Nothing here shuffles.

- :func:`temporal_train_test_split` - earlier rows train, later rows test,
  split at a fraction of the time span or at an explicit cutoff date.
- :class:`ForwardChainingCV` - expanding-window ("forward chaining") cross
  validation, drop-in for scikit-learn's ``cv=`` in ``GridSearchCV`` /
  ``cross_val_score``. Pass the per-row dates as ``groups``.
"""

from __future__ import annotations

import datetime as dt
from typing import Iterator, Sequence

import numpy as np
import pandas as pd

_DATE_CANDIDATES = ("as_of", "date", "day", "attendance_date", "window_date")


def _resolve_date_column(df: pd.DataFrame, date_col: str | None) -> str:
    if date_col is not None:
        if date_col not in df.columns:
            raise KeyError(f"date column {date_col!r} not in {list(df.columns)}")
        return date_col
    for candidate in _DATE_CANDIDATES:
        if candidate in df.columns:
            return candidate
    raise KeyError(
        f"no date column given and none of {_DATE_CANDIDATES} present in {list(df.columns)}"
    )


def _to_datetime(values) -> np.ndarray:
    return pd.to_datetime(pd.Series(list(values))).to_numpy()


def temporal_train_test_split(
    df: pd.DataFrame,
    test_size: float = 0.2,
    date_col: str | None = None,
    cutoff: dt.date | str | None = None,
    gap: dt.timedelta | int = 0,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split ``df`` by time: earlier rows -> train, later rows -> test.

    Parameters
    ----------
    df
        Rows to split. Not mutated; the returned frames are sorted by date with
        the original index preserved.
    test_size
        Fraction of the **distinct dates** (oldest-to-newest) placed in the test
        set. Ignored when ``cutoff`` is given.
    date_col
        Column holding the row's timestamp. Auto-detected from
        ``as_of``/``date``/... when omitted.
    cutoff
        Explicit boundary. Rows strictly before it train; rows on/after it test.
    gap
        Rows within ``gap`` (``timedelta`` or number of days) *before* the
        boundary are dropped from both sets, so a forward label window in the
        training data cannot peek past the boundary.

    Returns
    -------
    (train_df, test_df)
    """
    if not 0.0 < test_size < 1.0 and cutoff is None:
        raise ValueError("test_size must be in (0, 1) when no cutoff is given")

    col = _resolve_date_column(df, date_col)
    ordered = df.assign(_ts=pd.to_datetime(df[col])).sort_values("_ts", kind="mergesort")
    timestamps = ordered["_ts"]

    if cutoff is not None:
        boundary = pd.Timestamp(cutoff)
    else:
        unique_days = np.sort(timestamps.dt.normalize().unique())
        split_idx = int(np.ceil(len(unique_days) * (1.0 - test_size)))
        split_idx = min(max(split_idx, 1), len(unique_days) - 1)
        boundary = pd.Timestamp(unique_days[split_idx])

    gap_delta = pd.Timedelta(days=gap) if isinstance(gap, int) else pd.Timedelta(gap)

    train_mask = timestamps < (boundary - gap_delta)
    test_mask = timestamps >= boundary

    train_df = ordered.loc[train_mask].drop(columns="_ts")
    test_df = ordered.loc[test_mask].drop(columns="_ts")
    return train_df, test_df


class ForwardChainingCV:
    """Expanding-window time-series cross-validation.

    Fold ``k`` trains on the earliest ``k+1`` time-blocks and tests on block
    ``k+1``:

        fold 0:  train [B0]            test [B1]
        fold 1:  train [B0 B1]         test [B2]
        fold 2:  train [B0 B1 B2]      test [B3]
        ...

    Blocks are contiguous spans of the sorted samples, cut on date boundaries so
    a single date is never split across the train/test line.

    Parameters
    ----------
    n_splits
        Number of folds (>= 2). The samples are divided into ``n_splits + 1``
        blocks.
    gap
        ``timedelta`` or day count removed from the end of each training block,
        so a forward-looking label in training cannot overlap the test block.
    max_train_blocks
        If set, use a sliding rather than expanding window - keep at most this
        many trailing blocks in each training fold.

    Usage
    -----
    >>> cv = ForwardChainingCV(n_splits=4, gap=28)
    >>> GridSearchCV(rf, params, cv=cv).fit(X, y, groups=table["as_of"])
    """

    def __init__(
        self,
        n_splits: int = 5,
        gap: dt.timedelta | int = 0,
        max_train_blocks: int | None = None,
    ) -> None:
        if n_splits < 2:
            raise ValueError("n_splits must be >= 2")
        self.n_splits = n_splits
        self.gap = gap
        self.max_train_blocks = max_train_blocks

    def get_n_splits(self, X=None, y=None, groups=None) -> int:
        return self.n_splits

    def _order_and_keys(self, X, groups):
        n = len(X) if not hasattr(X, "shape") else X.shape[0]
        if groups is None:
            keys = np.arange(n)
        else:
            keys = _to_datetime(groups)
            if len(keys) != n:
                raise ValueError("groups length does not match X")
        order = np.argsort(keys, kind="mergesort")
        return order, keys[order], n

    def split(self, X, y=None, groups=None) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        order, sorted_keys, n = self._order_and_keys(X, groups)
        n_blocks = self.n_splits + 1

        # Block boundaries as positions in the sorted array, snapped so a run of
        # equal keys stays inside one block.
        edges = [0]
        for b in range(1, n_blocks):
            target = round(b * n / n_blocks)
            target = min(max(target, edges[-1] + 1), n)
            while 0 < target < n and sorted_keys[target - 1] == sorted_keys[target]:
                target += 1
            edges.append(min(target, n))
        edges.append(n)
        edges = sorted(set(edges))
        if len(edges) < n_blocks + 1:
            raise ValueError(
                f"cannot form {self.n_splits} forward-chaining folds from "
                f"{len(np.unique(sorted_keys))} distinct time points"
            )

        gap_delta = (
            pd.Timedelta(days=self.gap)
            if isinstance(self.gap, int)
            else pd.Timedelta(self.gap)
        )
        numeric_keys = groups is None

        for k in range(self.n_splits):
            train_lo_block = 0
            if self.max_train_blocks is not None:
                train_lo_block = max(0, (k + 1) - self.max_train_blocks)
            train_lo = edges[train_lo_block]
            train_hi = edges[k + 1]
            test_lo, test_hi = edges[k + 1], edges[k + 2]

            train_slice = np.arange(train_lo, train_hi)
            if len(train_slice) and not numeric_keys and gap_delta > pd.Timedelta(0):
                boundary = sorted_keys[test_lo] - gap_delta
                train_slice = train_slice[sorted_keys[train_slice] < boundary]

            test_slice = np.arange(test_lo, test_hi)
            if len(train_slice) == 0 or len(test_slice) == 0:
                continue
            yield order[train_slice], order[test_slice]


def forward_chaining_indices(
    dates: Sequence,
    n_splits: int = 5,
    gap: dt.timedelta | int = 0,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Eager list form of :meth:`ForwardChainingCV.split` for inspection/plots."""
    cv = ForwardChainingCV(n_splits=n_splits, gap=gap)
    return list(cv.split(np.zeros(len(dates)), groups=dates))


if __name__ == "__main__":
    demo = pd.DataFrame(
        {
            "as_of": pd.date_range("2026-02-01", periods=40, freq="7D").repeat(3),
            "student_id": [f"s{i%3}" for i in range(120)],
            "x": np.arange(120),
        }
    )
    train, test = temporal_train_test_split(demo, test_size=0.25)
    print(f"train {len(train)} rows up to {train['as_of'].max().date()}")
    print(f"test  {len(test)} rows from {test['as_of'].min().date()}")

    print("\nforward-chaining folds:")
    for i, (tr, te) in enumerate(forward_chaining_indices(demo["as_of"], n_splits=4, gap=28)):
        tr_max = demo["as_of"].iloc[tr].max().date()
        te_min = demo["as_of"].iloc[te].min().date()
        print(f"  fold {i}: train n={len(tr):3d} (<= {tr_max})   test n={len(te):3d} (>= {te_min})")
