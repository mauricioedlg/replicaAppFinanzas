"""Install, build, migrate and seed App Finanzas Mauricio without shell activation scripts."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parent.parent


def run(args, cwd=ROOT, env=None):
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description="Preparar App Finanzas Mauricio React + Django")
    parser.add_argument("--local-demo", action="store_true", help="Usar SQLite local explicitamente; no conecta a Neon")
    parser.add_argument("--skip-install", action="store_true", help="Usar dependencias ya instaladas")
    args = parser.parse_args()
    if sys.version_info < (3, 10):
        parser.error("Se requiere Python 3.10 o superior.")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        parser.error("Instala Node.js 22.12+ con npm antes de continuar.")
    python = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        print("Creando entorno Python...", flush=True)
        venv.create(ROOT / ".venv", with_pip=True)
    if not args.skip_install:
        run([python, "-m", "pip", "install", "-r", ROOT / "backend/requirements.txt"])
        run([npm, "ci" if (ROOT / "frontend/package-lock.json").exists() else "install"], ROOT / "frontend")
    env = os.environ.copy()
    if env.get("DEBUG", "").lower() not in {"true", "false", "1", "0", "yes", "no"}:
        env.pop("DEBUG", None)
    if args.local_demo:
        env.update(DATABASE_URL="", USE_SQLITE="true", DEBUG="true", DJANGO_DEBUG="true")
        print("Demostracion local con SQLite. Los datos no se envian a Neon.", flush=True)
    elif not (ROOT / ".env").exists() and not (ROOT / "backend/.env").exists() and not env.get("DATABASE_URL"):
        parser.error("Copia .env.example como .env y configura DATABASE_URL de Neon; o usa --local-demo.")
    run([python, "manage.py", "check"], ROOT / "backend", env)
    run([python, "manage.py", "migrate", "--noinput"], ROOT / "backend", env)
    run([python, "manage.py", "seed_demo"], ROOT / "backend", env)
    run([npm, "run", "build"], ROOT / "frontend", env)
    run([python, "manage.py", "collectstatic", "--noinput"], ROOT / "backend", env)
    flag = " --local-demo" if args.local_demo else ""
    print(f"\nPreparacion completa. Ejecuta: python scripts/dev.py{flag}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        raise SystemExit(exc.returncode) from None
