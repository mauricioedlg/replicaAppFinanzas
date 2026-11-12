"""Run the Django API and Vite together, or serve the built frontend."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description="Iniciar App Finanzas Mauricio")
    parser.add_argument("--local-demo", action="store_true", help="Usar la base SQLite de demostracion")
    parser.add_argument("--built", action="store_true", help="Servir frontend compilado desde Django en puerto 8000")
    parser.add_argument("--no-payment-worker", action="store_true", help="No iniciar el proceso de reintentos de correos de recargas")
    args = parser.parse_args()
    python = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        parser.error("Primero ejecuta python scripts/setup.py (o --local-demo).")
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    # This command always starts development servers, even when the database
    # is Neon. Unrelated inherited DEBUG values must not enable HTTPS redirects.
    env["DEBUG"] = "true"
    env["DJANGO_DEBUG"] = "true"
    if args.local_demo:
        env.update(DATABASE_URL="", USE_SQLITE="true", DEBUG="true", DJANGO_DEBUG="true")
    if args.built and not (ROOT / "frontend/dist/index.html").exists():
        parser.error("Falta frontend/dist. Ejecuta primero scripts/setup.py.")
    node = shutil.which("node")
    vite = ROOT / "frontend/node_modules/vite/bin/vite.js"
    if not args.built and (not node or not vite.exists()):
        parser.error("Faltan Node.js o las dependencias. Ejecuta primero scripts/setup.py.")
    processes = []
    try:
        processes.append(subprocess.Popen([str(python), "manage.py", "runserver", "127.0.0.1:8000", "--noreload"], cwd=ROOT / "backend", env=env))
        if not args.no_payment_worker:
            processes.append(subprocess.Popen([str(python), "manage.py", "send_payment_emails", "--watch", "--interval", "10"], cwd=ROOT / "backend", env=env))
        if not args.built:
            processes.append(subprocess.Popen([node, str(vite), "--host", "127.0.0.1", "--strictPort"], cwd=ROOT / "frontend", env=env))
        url = "http://127.0.0.1:8000" if args.built else "http://127.0.0.1:5173"
        print(f"App Finanzas Mauricio: {url}\nCtrl+C para detener los servidores.", flush=True)
        while all(process.poll() is None for process in processes):
            time.sleep(0.5)
        failed = next((process.returncode for process in processes if process.poll() is not None), 0)
        if failed:
            raise SystemExit(failed)
    except KeyboardInterrupt:
        print("\nDeteniendo App Finanzas Mauricio...", flush=True)
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    main()
