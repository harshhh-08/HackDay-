"""Parse Python source without importing it or executing the checkout fixture."""
import ast
from pathlib import Path

root = Path(__file__).resolve().parent.parent
count = 0
embedded = 0
for directory in ("services", "scripts", "tests", "fixtures"):
    for path in (root / directory).rglob("*.py"):
        tree = ast.parse(path.read_text(), filename=str(path.relative_to(root)))
        if path == root / "services/runner/verify.py":
            for node in tree.body:
                if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in {"BASELINE", "PIDS", "DISK", "MEMORY", "OUTPUT"} for target in node.targets):
                    ast.parse(ast.literal_eval(node.value), filename=f"{path.name}:embedded-probe")
                    embedded += 1
        count += 1
print(f"Syntax checked {count} Python files without executing fixture code.")
print(f"Syntax checked {embedded} embedded runner diagnostic programs; none were executed.")
