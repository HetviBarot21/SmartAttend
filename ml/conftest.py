"""Pytest bootstrap: put ml/training on sys.path so tests can import the
feature-engineering modules directly (feature_engineering, compute_labels,
temporal_split)."""

import sys
from pathlib import Path

_TRAINING = Path(__file__).parent / "training"
if str(_TRAINING) not in sys.path:
    sys.path.insert(0, str(_TRAINING))
