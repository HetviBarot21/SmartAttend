"""Put ml/training on sys.path for the tests."""

import sys
from pathlib import Path

_TRAINING = Path(__file__).parent / "training"
if str(_TRAINING) not in sys.path:
    sys.path.insert(0, str(_TRAINING))
