"""Shared pytest fixtures for notebooklm daemon tests."""
import sys
from pathlib import Path

# Allow `import notebooklm_daemon` etc. from scripts/
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))
