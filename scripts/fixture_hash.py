from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from services.common import ROOT
from services.runner.policy import snapshot_hash

print(snapshot_hash(ROOT / "fixtures/checkout"))
