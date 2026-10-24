"""Create a source-only WhatsApp-friendly ZIP. Never include local secrets/data."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
EXCLUDED = {"node_modules", ".git", ".local", ".venv", "__pycache__", ".pytest_cache", "dist", ".DS_Store"}


def allowed(path):
    relative = path.relative_to(ROOT)
    if any(part in EXCLUDED for part in relative.parts) or path.is_symlink():
        return False
    if path.name.startswith(".env") and path.name != ".env.example":
        return False
    return not path.name.endswith((".local.json", ".pyc", ".log", ".sqlite3", ".pem", ".key", ".zip"))


if __name__ == "__main__":
    destination = ROOT / "dist"
    destination.mkdir(exist_ok=True)
    archive = destination / "bugout-source.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for path in sorted(ROOT.rglob("*")):
            if path.is_file() and allowed(path):
                output.write(path, Path("bug.out") / path.relative_to(ROOT))
    with zipfile.ZipFile(archive) as check:
        if check.testzip() is not None:
            raise SystemExit("Archive integrity check failed")
        assert not any("node_modules/" in name or name.endswith("/.env") or "/.local/" in name for name in check.namelist())
        count = len(check.namelist())
    print(f"Created {archive} ({archive.stat().st_size} bytes, {count} source files).")
