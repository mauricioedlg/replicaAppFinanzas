"""Configure or run the local Stripe listener using the root .env credentials."""
import argparse
import codecs
from io import StringIO
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
EVENTS = "payment_intent.succeeded,payment_intent.payment_failed"
SECRET_PATTERN = re.compile(r"whsec_[A-Za-z0-9_]+")


def listener_command():
    values = dotenv_values(ENV_FILE, encoding="utf-8-sig")
    key = (values.get("STRIPE_SECRET_KEY") or "").strip()
    if not key.startswith(("sk_test_", "rk_test_")):
        raise ValueError("Configura STRIPE_SECRET_KEY con una clave de pruebas en el .env de la raíz.")
    binary = ROOT / ".qa" / "bin" / "stripe-cli" / ("stripe.exe" if os.name == "nt" else "stripe")
    executable = str(binary) if binary.is_file() else shutil.which("stripe")
    if not executable:
        raise ValueError("Stripe CLI no está disponible. Consulta docs/STRIPE.md para instalarla.")
    config_root = ROOT / ".qa" / "stripe-config"
    config_file = config_root / "stripe" / "config.toml"
    config_file.parent.mkdir(parents=True, exist_ok=True)
    child_env = os.environ.copy()
    child_env.update(
        STRIPE_API_KEY=key,
        XDG_CONFIG_HOME=str(config_root),
        STRIPE_NO_AUTO_UPDATE="1",
    )
    command = [executable, "--config", str(config_file), "--device-name", "appFinanzas", "listen"]
    return command, child_env, values


def configure_secret(command, child_env, values):
    try:
        result = subprocess.run(
            [*command, "--print-secret"], env=child_env, cwd=ROOT,
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired:
        raise ValueError("Stripe no respondió a tiempo. No se modificó el archivo .env.") from None
    match = SECRET_PATTERN.search(result.stdout)
    if result.returncode or not match:
        raise ValueError("No se pudo obtener el secreto desde Stripe. Revisa la clave de pruebas y la conexión. El .env se conservó.")
    secret = match.group()
    original = ENV_FILE.read_bytes()
    text = original.decode("utf-8-sig")
    updated, count = re.subn(
        r"(?m)^([ \t]*(?:export[ \t]+)?STRIPE_WEBHOOK_SECRET[ \t]*=)[^\r\n]*",
        lambda item: item.group(1) + secret, text,
    )
    if not count:
        newline = "\r\n" if "\r\n" in text else "\n"
        updated = text.rstrip("\r\n") + newline + "STRIPE_WEBHOOK_SECRET=" + secret + newline
    encoded = updated.encode("utf-8")
    if original.startswith(codecs.BOM_UTF8):
        encoded = codecs.BOM_UTF8 + encoded
    candidate = dotenv_values(stream=StringIO(updated))
    assert all(candidate.get(name) == value for name, value in values.items() if name != "STRIPE_WEBHOOK_SECRET")
    if ENV_FILE.read_bytes() != original:
        raise ValueError("El .env cambió durante la configuración. No se sobrescribió; vuelve a intentarlo.")
    temporary = ENV_FILE.with_name(".env.stripe-tmp")
    temporary.write_bytes(encoded)
    temporary.replace(ENV_FILE)
    print("STRIPE_WEBHOOK_SECRET guardado en el .env de la raíz. Las otras variables se conservaron.")


def run_listener(command, child_env, values):
    expected = (values.get("STRIPE_WEBHOOK_SECRET") or "").strip()
    if not SECRET_PATTERN.fullmatch(expected):
        raise ValueError("Primero ejecuta este script con --configure para guardar el secreto del webhook.")
    process = subprocess.Popen(
        [*command, "--events", EVENTS, "--forward-to", "http://127.0.0.1:8000/api/stripe/webhook/"],
        env=child_env, cwd=ROOT, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    try:
        for line in process.stdout:
            found = SECRET_PATTERN.search(line)
            if found and found.group() != expected:
                raise ValueError("El secreto del listener cambió. Ejecuta --configure y reinicia Django.")
            line = line.replace(child_env["STRIPE_API_KEY"], "[clave oculta]")
            print(SECRET_PATTERN.sub("[secreto del webhook oculto]", line), end="", flush=True)
        return process.wait()
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description="Configurar o reenviar webhooks de Stripe del entorno de pruebas")
    parser.add_argument("--configure", action="store_true", help="Obtener el secreto y guardarlo en el .env sin mostrarlo")
    args = parser.parse_args()
    try:
        command, child_env, values = listener_command()
        if args.configure:
            configure_secret(command, child_env, values)
            return 0
        return run_listener(command, child_env, values)
    except (ValueError, OSError) as error:
        print(str(error) if isinstance(error, ValueError) else "No se pudo iniciar Stripe CLI o actualizar el archivo .env.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Listener de Stripe detenido.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
