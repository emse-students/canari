# -*- coding: utf-8 -*-
"""Android build / deploy / logcat GUI for Canari.

Built for the device-verification runbook (docs/wiki/device-verification.md): the logcat
whitelist below is the set of tags whose lines are the verdict of a check, so a check can
never fail merely because its tag was filtered out.

The UI is French on purpose - it is a personal dev tool. Comments and console output are
English, per the project language rule.
"""
import tkinter as tk
from tkinter import ttk, scrolledtext, filedialog, messagebox
import subprocess
import threading
import queue
import datetime
import sys
import re
import os
import glob
from typing import Optional

# === DEFAULT CONFIGURATION ===
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Two levels up is the repository root: this file lives in tools/android/. Normalised because it
# is shown in the UI and passed to subprocesses, where "tools/android/../../frontend" would work
# but would read as a mistake in every log line that quotes it.
REPO_ROOT = os.path.normpath(os.path.join(SCRIPT_DIR, os.pardir, os.pardir))
DEFAULT_PROJECT_DIR = os.path.join(REPO_ROOT, "frontend")
DEFAULT_PACKAGE_NAME = "fr.emse.canari"
DEFAULT_ACTIVITY_NAME = f"{DEFAULT_PACKAGE_NAME}/.MainActivity"

# Where `bun tauri android build` drops its APKs, one directory per ABI flavour.
APK_SEARCH_GLOB = r"src-tauri\gen\android\app\build\outputs\apk\*\debug\*.apk"

# Device ABI -> the APK flavours it can run, best first. `universal` runs anywhere.
# Neither "the hardcoded universal path" (what this script used to do - it installs whatever
# an older build happened to leave there) nor "the newest APK" is right: the outputs directory
# keeps x86_64 and arm builds from previous runs, and the newest of those is regularly the one
# an arm64 phone cannot execute.
ABI_TO_FLAVOURS: dict[str, list[str]] = {
    "arm64-v8a": ["arm64", "universal"],
    "armeabi-v7a": ["arm", "universal"],
    "x86_64": ["x86_64", "universal"],
    "x86": ["x86", "universal"],
}
DEFAULT_FLAVOURS = ["arm64", "universal"]  # the build targets aarch64

PROJECT_DIR = DEFAULT_PROJECT_DIR
PACKAGE_NAME = DEFAULT_PACKAGE_NAME
ACTIVITY_NAME = DEFAULT_ACTIVITY_NAME
ANDROID_HOME: str = ""

SYSTEM_SOURCE = "Système"

# Keep the text widgets bounded: an hour of logcat is millions of characters and Tk gets
# slower with every line it holds.
MAX_LINES_PER_WIDGET = 8000
# Lines drained per UI tick. Draining the whole queue freezes the UI during a burst.
MAX_LINES_PER_TICK = 400

# No console window flashing on every adb call (Windows only).
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _run(cmd: list[str], timeout: Optional[int] = None) -> subprocess.CompletedProcess[str]:
    """Runs a command capturing text output, without popping a console window."""
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=_NO_WINDOW,
    )


def find_android_sdk() -> Optional[str]:
    """Looks for the Android SDK in the usual places. Explicit env vars win."""
    possible_paths = [
        os.environ.get("ANDROID_HOME", ""),
        os.environ.get("ANDROID_SDK_ROOT", ""),
        os.path.expanduser("~\\AppData\\Local\\Android\\Sdk"),  # Android Studio default
        "C:\\Android\\Sdk",  # manual install
    ]

    for path in possible_paths:
        if path and os.path.isdir(path):
            essentials = ["tools", "platform-tools", "cmdline-tools", "platforms", "build-tools"]
            if any(os.path.isdir(os.path.join(path, e)) for e in essentials):
                return path

    return None


def setup_android_environment() -> str:
    """Sets ANDROID_HOME and returns the SDK path, or "" when none was found."""
    global ANDROID_HOME

    found_sdk = find_android_sdk()
    if found_sdk:
        ANDROID_HOME = found_sdk
        print(f"[OK] Android SDK found: {ANDROID_HOME}")
        return ANDROID_HOME

    print("[ERROR] Android SDK not found.")
    print("[INFO] Expected locations:")
    print("  - %LOCALAPPDATA%\\Android\\Sdk (Android Studio)")
    print("  - C:\\Android\\Sdk (manual install)")
    print("[INFO] Set ANDROID_HOME manually, or install Android Studio.")

    return ""


def download_android_cli_tools() -> bool:
    """Downloads and extracts the Android command-line tools."""
    import zipfile
    import shutil
    from urllib.request import urlopen

    print("[INFO] Downloading the Android CLI tools...")

    cli_tools_url = "https://dl.google.com/android/repository/commandlinetools-win-10406996_latest.zip"

    sdk_base = os.path.expanduser("~\\AppData\\Local\\Android\\Sdk")
    cmdline_tools_path = os.path.join(sdk_base, "cmdline-tools")
    latest_path = os.path.join(cmdline_tools_path, "latest")

    os.makedirs(cmdline_tools_path, exist_ok=True)
    zip_path = os.path.join(sdk_base, "cmdlinetools.zip")

    try:
        print(f"[INFO] Source: {cli_tools_url}")
        with urlopen(cli_tools_url) as response:
            total_size = int(response.headers.get("content-length", 0))
            downloaded = 0

            with open(zip_path, "wb") as f:
                while True:
                    chunk = response.read(8192)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        print(f"[INFO] Progress: {(downloaded / total_size) * 100:.1f}%", end="\r")

        print("[OK] Download finished          ")

        print("[INFO] Extracting...")
        with zipfile.ZipFile(zip_path, "r") as zip_ref:
            zip_ref.extractall(cmdline_tools_path)

        # The archive extracts as `cmdline-tools/`; sdkmanager expects it at `latest/`.
        extracted_path = os.path.join(cmdline_tools_path, "cmdline-tools")
        if os.path.exists(extracted_path):
            if os.path.exists(latest_path):
                shutil.rmtree(latest_path)
            shutil.move(extracted_path, latest_path)

        os.remove(zip_path)

        print(f"[OK] Android CLI tools extracted to: {latest_path}")
        return True

    except Exception as e:
        print(f"[ERROR] CLI tools download failed: {e}")
        if os.path.exists(zip_path):
            os.remove(zip_path)
        return False


def install_android_sdk() -> bool:
    """Installs the Android SDK packages through sdkmanager, fetching it first if needed."""
    print("[INFO] Installing the Android SDK...")

    possible_sdkmanager_paths = [
        os.path.expanduser("~\\AppData\\Local\\Android\\Sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat"),
        "C:\\Android\\Sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat",
    ]

    sdkmanager_path = None
    for path in possible_sdkmanager_paths:
        if os.path.isfile(path):
            sdkmanager_path = path
            break

    if not sdkmanager_path:
        print("[INFO] sdkmanager not found, fetching the CLI tools first.")
        if not download_android_cli_tools():
            return False

        sdkmanager_path = os.path.expanduser(
            "~\\AppData\\Local\\Android\\Sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat"
        )
        if not os.path.isfile(sdkmanager_path):
            print("[ERROR] sdkmanager still missing after the download.")
            return False

    try:
        print(f"[INFO] Using sdkmanager: {sdkmanager_path}")

        android_home = os.path.dirname(os.path.dirname(os.path.dirname(sdkmanager_path)))
        env = os.environ.copy()
        env["ANDROID_HOME"] = android_home
        print(f"[INFO] ANDROID_HOME={android_home}")

        print("[INFO] Accepting the Android licences...")
        licenses_result = subprocess.run(
            [sdkmanager_path, "--licenses"],
            input="y\n" * 20,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            env=env,
            creationflags=_NO_WINDOW,
        )
        if licenses_result.returncode == 0:
            print("[OK] Licences accepted")
        else:
            # Reporting success here regardless is how a licence refusal used to turn into a
            # confusing package failure three steps later.
            print(f"[WARN] sdkmanager --licenses exited with {licenses_result.returncode}")
            if licenses_result.stderr:
                print(f"       {licenses_result.stderr[:300]}")

        packages = [
            "platforms;android-34",
            "build-tools;34.0.0",
            "ndk;26.1.10909125",
        ]

        failed: list[str] = []
        for package in packages:
            print(f"[INFO] Installing {package}...")
            result = subprocess.run(
                [sdkmanager_path, package],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=600,
                env=env,
                creationflags=_NO_WINDOW,
            )

            if result.returncode != 0:
                failed.append(package)
                print(f"[WARN] {package} failed")
                if result.stderr:
                    print(f"       {result.stderr[:200]}")
            else:
                print(f"[OK] {package} installed")

        if failed:
            print(f"[ERROR] SDK install incomplete, {len(failed)} package(s) failed: {', '.join(failed)}")
            return False

        print("[OK] Android SDK install complete")
        return True

    except subprocess.TimeoutExpired:
        print("[ERROR] Android SDK install timed out (> 10 minutes)")
        return False
    except Exception as e:
        print(f"[ERROR] Android SDK install failed: {e}")
        return False


def strip_ansi(text: str) -> str:
    """Removes ANSI escape sequences."""
    ansi_escape = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
    return ansi_escape.sub("", text)


def detect_devices() -> dict[str, str]:
    """Lists connected devices as {device_id: label}. Labels are unique even for twin models."""
    devices: dict[str, str] = {}
    try:
        # Starting the server explicitly keeps its startup noise out of `devices -l` output.
        print("[INFO] Starting the ADB server...")
        _run(["adb", "start-server"], timeout=15)

        print("[INFO] Detecting devices...")
        result = _run(["adb", "devices", "-l"], timeout=30)

        raw: list[tuple[str, str]] = []
        for line in result.stdout.strip().split("\n")[1:]:  # skip "List of devices attached"
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            # The state is its own column. Substring-matching "device" on the whole line also
            # matched ids and model names, and mis-read half the states.
            if len(parts) < 2 or parts[1] != "device":
                if len(parts) >= 2:
                    print(f"  [SKIP] {parts[0]} is '{parts[1]}'")
                continue

            device_id = parts[0]
            model = device_id
            for part in parts[2:]:
                if part.startswith("model:"):
                    model = part[len("model:"):] or device_id
                    break
            raw.append((device_id, model))

        # Two phones of the same model would otherwise share a label - and a shared label means
        # one tab, one colour and two devices' logs mixed into it with no way to tell them apart.
        model_counts: dict[str, int] = {}
        for _, model in raw:
            model_counts[model] = model_counts.get(model, 0) + 1

        for device_id, model in raw:
            label = model if model_counts[model] == 1 else f"{model} ({device_id[-4:]})"
            devices[device_id] = label
            print(f"  [OK] {label} ({device_id})")

        if not devices:
            print("[WARN] No device detected (check the USB cable, USB debugging, and the ADB prompt)")

    except subprocess.TimeoutExpired:
        print("[TIMEOUT] ADB detection timed out. Try again.")
    except FileNotFoundError:
        print("[ERROR] adb not found. Install the Android platform-tools and put them on PATH.")
    except Exception as e:
        print(f"[ERROR] Device detection failed: {e}")

    return devices


def device_abi(device_id: str) -> Optional[str]:
    """Reads the device's primary ABI, or None when it cannot be asked."""
    try:
        result = _run(["adb", "-s", device_id, "shell", "getprop", "ro.product.cpu.abi"], timeout=15)
        abi = result.stdout.strip()
        return abi or None
    except Exception:
        return None


def find_apk(project_dir: str, abi: Optional[str] = None) -> Optional[str]:
    """Returns the debug APK to install: the newest one of a flavour the device can run.

    Falls back to the arm64/universal order when the ABI is unknown, since the build targets
    aarch64. Returns None when no compatible APK exists - installing an incompatible one is a
    failure five minutes later, at `am start`, with an error that names nothing useful.
    """
    matches = glob.glob(os.path.join(project_dir, APK_SEARCH_GLOB))
    if not matches:
        return None

    flavours = ABI_TO_FLAVOURS.get(abi or "", DEFAULT_FLAVOURS)
    for flavour in flavours:
        # The flavour is the directory two levels above the file: .../apk/<flavour>/debug/x.apk
        candidates = [m for m in matches if os.path.basename(os.path.dirname(os.path.dirname(m))) == flavour]
        if candidates:
            return max(candidates, key=os.path.getmtime)
    return None


# Logcat lines dropped outright: recurring noise with no diagnostic value.
_MUTE_RE: list[re.Pattern[str]] = [
    re.compile(r"\[API\] [→←].*/api/presence"),
    re.compile(r"^-+ beginning of "),  # logcat's own buffer separators
]

_LOGCAT_LINE_RE = re.compile(
    r"\d{2}-\d{2} (\d{2}:\d{2}:\d{2})\.\d{3}\s+\d+\s+\d+\s+\w+\s+([^:]+):\s+(.*)"
)
_TAURI_MSG_RE = re.compile(r"Msg:\s+(.*)")
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
_HEX_RE = re.compile(r"\b[0-9a-f]{16,}\b", re.IGNORECASE)


def truncate_ids(text: str) -> str:
    """Shortens UUIDs and long hex runs to their first 8 characters."""
    text = _UUID_RE.sub(lambda m: m.group()[:8] + "…", text)
    text = _HEX_RE.sub(lambda m: m.group()[:8] + "…", text)
    return text


def parse_logcat_line(raw: str) -> Optional[str]:
    """Extracts timestamp + useful message. Returns None for a line that should be dropped."""
    line = strip_ansi(raw.strip())
    if not line:
        return None

    for pattern in _MUTE_RE:
        if pattern.search(line):
            return None

    m = _LOGCAT_LINE_RE.match(line)
    if not m:
        return line  # unrecognized shape: keep it verbatim rather than lose it

    time_str, tag, msg = m.group(1), m.group(2).strip(), m.group(3)

    if "Tauri/Console" in tag:
        tm = _TAURI_MSG_RE.search(msg)
        if tm:
            msg = tm.group(1)
    else:
        msg = f"[{tag}] {msg}"

    for pattern in _MUTE_RE:
        if pattern.search(msg):
            return None

    return f"{time_str} {truncate_ids(msg)}"


# Logcat whitelist. `*:S` silences everything, so a tag missing HERE is a check that can never
# pass: its verdict line simply never arrives. Keep this in sync with the TAG constants in
# gen/android/.../*.kt and with docs/wiki/device-verification.md.
LOGCAT_TAGS = [
    "mines_app_lib:D",       # Rust side of the Tauri app ([MLS], [FCM], [PushCtx], [BOOTSTRAP]...)
    "CanariRust:D",          # OpenMLS engine over JNI, when it tags separately
    "CanariFCM:D",           # CanariFirebaseMessagingService - checks B and D verdicts
    "CanariWorker:D",        # MlsBackgroundWorker (WorkManager)
    "CanariApp:D",           # CanariApplication: init, push secret, device-key migration
    "CanariBoot:D",          # CanariBootReceiver: work rescheduled after a reboot
    "CanariNotifAction:D",   # Notification action buttons (reply, mark as read)
    "CanariOutboxRetry:D",   # OutboxRetryWorker - check J verdict
    "MlsDeviceKeyStore:D",   # Keystore reads/writes - check B verdict ("retrieve: success alias=")
    "PushSecretKeystore:D",  # Push secret at rest, and its migration out of SharedPreferences
    "KeyboardMedia:D",       # Keyboard media bridge (GIF/sticker paste)
    "fr.emse.canari:D",      # Tauri log plugin, tagged with the package name
    "chromium:I",            # console.log() from the WebView when the Tauri plugin misses it
    "Tauri/Console:V",       # WebView console through the Tauri plugin
    "MainActivity:D",        # FCM token sync at startup
    "FirebaseMessaging:W",   # FCM SDK (token and connection errors)
    "WM-WorkerWrapper:W",    # WorkManager internals (retry / failure)
    "AndroidRuntime:E",      # crashes (panics, exceptions)
    "System.err:W",
]


class TauriManagerApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root: tk.Tk = root
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)

        # (source_key, timestamp, message) - source_key is a device id or SYSTEM_SOURCE.
        self.log_queue: queue.Queue[tuple[str, str, str]] = queue.Queue()

        # One logcat per device id. A flat list let a second logcat start on a device that
        # already had one - both readers stayed alive and every line was logged twice.
        self.logcat_processes: dict[str, subprocess.Popen[str]] = {}
        self.process_lock = threading.Lock()
        self.current_processes: list[subprocess.Popen[str]] = []

        self.devices: dict[str, str] = {}  # {device_id: label}
        self.device_buttons: dict[str, ttk.Button] = {}
        self.device_text_areas: dict[str, scrolledtext.ScrolledText] = {}

        self.show_config_window()

    # === CONFIG WINDOW ===
    def show_config_window(self) -> None:
        """Initial configuration step: project path, SDK, device detection.

        It lives INSIDE the root window rather than in a Toplevel. A Toplevel declared
        `transient` of a withdrawn master is never mapped on Windows, so the form used to
        exist without ever being drawn.
        """
        global ANDROID_HOME

        self.root.title("Canari - Configuration initiale")
        self.root.geometry("640x520")

        config_win = ttk.Frame(self.root)
        config_win.pack(fill=tk.BOTH, expand=True)

        ttk.Label(config_win, text="Chemin du projet frontend :", font=("Segoe UI", 10)).pack(
            pady=(10, 5), padx=10, anchor=tk.W
        )

        path_frame = ttk.Frame(config_win)
        path_frame.pack(pady=5, padx=10, fill=tk.X)

        path_var = tk.StringVar(value=PROJECT_DIR)
        ttk.Entry(path_frame, textvariable=path_var, width=50).pack(
            side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5)
        )

        def browse_path():
            selected = filedialog.askdirectory(title="Sélectionnez le répertoire frontend", initialdir=PROJECT_DIR)
            if selected:
                path_var.set(selected)

        ttk.Button(path_frame, text="Parcourir…", command=browse_path).pack(side=tk.LEFT)

        # --- Android SDK ---
        ttk.Label(config_win, text="Android SDK :", font=("Segoe UI", 10, "bold")).pack(
            pady=(15, 5), padx=10, anchor=tk.W
        )

        android_frame = ttk.Frame(config_win)
        android_frame.pack(pady=5, padx=10, fill=tk.X)

        android_var = tk.StringVar(value=ANDROID_HOME or "(non détecté)")
        ttk.Entry(android_frame, textvariable=android_var, width=50).pack(
            side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5)
        )

        def browse_android():
            selected = filedialog.askdirectory(
                title="Sélectionnez le répertoire Android SDK",
                initialdir=os.path.expanduser("~\\AppData\\Local\\Android"),
            )
            if selected:
                android_var.set(selected)

        ttk.Button(android_frame, text="Parcourir…", command=browse_android).pack(side=tk.LEFT, padx=(0, 5))

        sdk_status_label = ttk.Label(config_win, text="", foreground="gray", font=("Segoe UI", 9))
        sdk_status_label.pack(pady=2, padx=10, anchor=tk.W)

        def check_android_sdk():
            """Runs on the main thread only - it touches widgets."""
            sdk_path = android_var.get()
            if sdk_path and sdk_path != "(non détecté)":
                if os.path.isdir(sdk_path):
                    sdk_status_label.config(text="SDK Android valide", foreground="green")
                else:
                    sdk_status_label.config(text="Répertoire invalide", foreground="red")
                return

            found = find_android_sdk()
            if found:
                android_var.set(found)
                sdk_status_label.config(text="SDK Android détecté automatiquement", foreground="green")
            else:
                sdk_status_label.config(
                    text="SDK Android introuvable. Installez Android Studio ou indiquez le chemin.",
                    foreground="orange",
                )

        def install_sdk_button():
            sdk_status_label.config(text="Installation en cours… (5 à 10 minutes)", foreground="blue")

            def install_task():
                ok = install_android_sdk()
                found = find_android_sdk() if ok else None

                def update_ui():
                    # Widgets and Tk variables are touched on the main thread only. Setting them
                    # from the worker is what made this window hang or die at random.
                    if found:
                        android_var.set(found)
                    if ok:
                        sdk_status_label.config(
                            text="SDK Android installé. Redémarrez l'application.", foreground="green"
                        )
                    else:
                        sdk_status_label.config(
                            text="Installation échouée - voir la console pour le détail.", foreground="red"
                        )

                config_win.after(0, update_ui)

            threading.Thread(target=install_task, daemon=True).start()

        sdk_buttons_frame = ttk.Frame(config_win)
        sdk_buttons_frame.pack(pady=5, padx=10, fill=tk.X)
        ttk.Button(sdk_buttons_frame, text="Vérifier le SDK", command=check_android_sdk).pack(side=tk.LEFT, padx=5)
        ttk.Button(sdk_buttons_frame, text="Installer le SDK", command=install_sdk_button).pack(side=tk.LEFT, padx=5)

        ttk.Label(config_win, text="Appareils détectés :", font=("Segoe UI", 10)).pack(
            pady=(10, 5), padx=10, anchor=tk.W
        )

        device_frame = ttk.Frame(config_win)
        device_frame.pack(pady=5, padx=10, fill=tk.BOTH, expand=True)

        scrollbar = ttk.Scrollbar(device_frame)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        device_listbox = tk.Listbox(device_frame, yscrollcommand=scrollbar.set, height=6)
        device_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.config(command=device_listbox.yview)

        status_label = ttk.Label(config_win, text="", foreground="gray")
        status_label.pack(pady=5, padx=10, anchor=tk.W)

        detecting = threading.Event()

        def detect_and_refresh():
            """Detects in a worker thread, updates the widgets on the main thread."""
            if detecting.is_set():
                return
            detecting.set()
            device_listbox.delete(0, tk.END)
            status_label.config(text="Détection en cours (10 à 30 secondes)…", foreground="blue")

            def worker():
                detected = detect_devices()

                def update_ui():
                    detecting.clear()
                    device_listbox.delete(0, tk.END)
                    if detected:
                        for dev_id, dev_name in detected.items():
                            device_listbox.insert(tk.END, f"{dev_name}  -  {dev_id}")
                        status_label.config(
                            text=f"{len(detected)} appareil(s) détecté(s)", foreground="green"
                        )
                    else:
                        device_listbox.insert(tk.END, "Aucun appareil détecté")
                        status_label.config(
                            text="Vérifiez : câble USB, mode développeur, débogage USB, autorisation ADB",
                            foreground="orange",
                        )

                config_win.after(0, update_ui)

            threading.Thread(target=worker, daemon=True).start()

        button_frame = ttk.Frame(config_win)
        button_frame.pack(pady=10, padx=10, fill=tk.X)

        ttk.Button(button_frame, text="Détecter les appareils", command=detect_and_refresh).pack(side=tk.LEFT, padx=5)

        def confirm():
            global PROJECT_DIR, ANDROID_HOME
            project_path = path_var.get()
            if not os.path.isdir(project_path):
                messagebox.showerror("Erreur", f"Répertoire invalide : {project_path}")
                return

            android_path = android_var.get()
            if android_path and android_path != "(non détecté)" and not os.path.isdir(android_path):
                messagebox.showerror("Erreur", f"Android SDK invalide : {android_path}")
                return

            PROJECT_DIR = project_path
            ANDROID_HOME = android_path if android_path and android_path != "(non détecté)" else ""

            self.devices = detect_devices()

            if not self.devices:
                keep_going = messagebox.askyesno(
                    "Aucun appareil",
                    "Aucun appareil détecté.\nContinuer quand même, pour compiler uniquement ?",
                )
                if not keep_going:
                    return

            config_win.destroy()
            self.root.title("Gestionnaire Tauri Android - Canari")
            self.root.geometry("1600x900")
            self.setup_ui()
            self.root.after(100, self.process_log_queue)

        ttk.Button(button_frame, text="Confirmer et continuer", command=confirm).pack(side=tk.RIGHT, padx=5)

        # Initial checks. The SDK check touches widgets, so it stays on the main thread; only
        # the device scan (which shells out to adb) goes to a worker.
        config_win.after(0, check_android_sdk)
        config_win.after(50, detect_and_refresh)

    # === MAIN UI ===
    def setup_ui(self) -> None:
        self.control_frame = ttk.LabelFrame(self.root, text="Actions", padding=(10, 5))
        self.control_frame.pack(fill=tk.X, padx=10, pady=5)

        ttk.Button(self.control_frame, text="1. Compiler (Bun)", command=self.run_build).pack(side=tk.LEFT, padx=5)

        # Anchor for the per-device buttons, so refresh can insert them in the right place.
        self.device_button_anchor = ttk.Frame(self.control_frame)
        self.device_button_anchor.pack(side=tk.LEFT)

        self.deploy_all_button = ttk.Button(
            self.control_frame, text="Tout installer & lancer", command=self.deploy_all
        )
        self.deploy_all_button.pack(side=tk.LEFT, padx=5)

        # A clean install WIPES the app data. Most runbook checks need the state that the
        # previous check left behind, so reinstalling over the top is the default.
        self.clean_install_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            self.control_frame,
            text="Install propre (efface les données)",
            variable=self.clean_install_var,
        ).pack(side=tk.LEFT, padx=5)

        ttk.Separator(self.control_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=10)

        ttk.Button(self.control_frame, text="Lancer Logcat", command=self.start_all_logcats).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="Arrêter Logcat", command=self.stop_all_logcats).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="Forcer l'arrêt de l'app", command=self.force_stop_all).pack(
            side=tk.LEFT, padx=5
        )

        ttk.Separator(self.control_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=10)

        ttk.Button(self.control_frame, text="Détecter les appareils", command=self.refresh_devices).pack(
            side=tk.LEFT, padx=5
        )
        ttk.Button(self.control_frame, text="Interrompre la compilation", command=self.stop_all_processes).pack(
            side=tk.LEFT, padx=5
        )

        ttk.Button(self.control_frame, text="Effacer", command=self.clear_displays).pack(side=tk.RIGHT, padx=5)
        ttk.Button(self.control_frame, text="Enregistrer les logs…", command=self.save_logs).pack(
            side=tk.RIGHT, padx=5
        )

        # --- Log tabs ---
        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        self.text_system: scrolledtext.ScrolledText = scrolledtext.ScrolledText(
            self.notebook, wrap=tk.WORD, bg="#1e1e1e", fg="#ce9178", font=("Consolas", 10)
        )
        self.notebook.add(self.text_system, text="Système (compilation / infos)")

        self.text_combined: scrolledtext.ScrolledText = scrolledtext.ScrolledText(
            self.notebook, wrap=tk.WORD, bg="#1e1e1e", fg="#d4d4d4", font=("Consolas", 10)
        )
        self.notebook.add(self.text_combined, text="Logs combinés")
        self.text_combined.tag_config(SYSTEM_SOURCE, foreground="#ce9178")

        for device_id in self.devices:
            self.ensure_device_tab(device_id)

        self.rebuild_device_buttons()

    _DEVICE_COLORS = ["#569cd6", "#4ec9b0", "#dcdcaa", "#c586c0", "#9cdcfe"]

    def ensure_device_tab(self, device_id: str) -> scrolledtext.ScrolledText:
        """Returns the text area for a device, creating its tab on first use.

        Creating tabs on demand is what lets a third device - or one plugged in after startup -
        have somewhere to log. The old fixed two-pane layout silently dropped everything else.
        """
        existing = self.device_text_areas.get(device_id)
        if existing is not None:
            return existing

        label = self.devices.get(device_id, device_id)
        color = self._DEVICE_COLORS[len(self.device_text_areas) % len(self._DEVICE_COLORS)]

        text_area = scrolledtext.ScrolledText(
            self.notebook, wrap=tk.WORD, bg="#1e1e1e", fg=color, font=("Consolas", 9)
        )
        # Insert device tabs before the combined tab so it stays last.
        self.notebook.insert(self.notebook.index("end") - 1, text_area, text=label)
        self.device_text_areas[device_id] = text_area
        self.text_combined.tag_config(device_id, foreground=color)
        return text_area

    def rebuild_device_buttons(self) -> None:
        """Rebuilds the per-device deploy buttons after a detection pass."""
        for btn in self.device_buttons.values():
            btn.destroy()
        self.device_buttons.clear()

        for device_id, device_name in self.devices.items():
            btn = ttk.Button(
                self.device_button_anchor,
                text=f"2. Installer & lancer ({device_name})",
                command=lambda did=device_id: self.run_deploy(did),
            )
            btn.pack(side=tk.LEFT, padx=5)
            self.device_buttons[device_id] = btn

        state = tk.NORMAL if self.devices else tk.DISABLED
        self.deploy_all_button.config(state=state)

    # === LOGGING ===
    def label_for(self, source: str) -> str:
        """Human-readable name for a log source key."""
        if source == SYSTEM_SOURCE:
            return SYSTEM_SOURCE
        return self.devices.get(source, source)

    def log(self, source: str, message: str) -> None:
        """Queues a message for the UI thread. `source` is a device id or SYSTEM_SOURCE."""
        timestamp = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
        cleaned_message = strip_ansi(message.rstrip("\n").rstrip("\r"))
        self.log_queue.put((source, timestamp, cleaned_message))

    @staticmethod
    def _trim(widget: scrolledtext.ScrolledText) -> None:
        """Drops the oldest lines once a widget exceeds MAX_LINES_PER_WIDGET."""
        line_count = int(widget.index("end-1c").split(".")[0])
        if line_count > MAX_LINES_PER_WIDGET:
            widget.delete("1.0", f"{line_count - MAX_LINES_PER_WIDGET}.0")

    def process_log_queue(self) -> None:
        """Drains queued messages into the widgets. Runs on the UI thread."""
        touched: set[scrolledtext.ScrolledText] = set()
        drained = 0

        while drained < MAX_LINES_PER_TICK:
            try:
                source, timestamp, message = self.log_queue.get_nowait()
            except queue.Empty:
                break
            drained += 1

            formatted_msg = f"[{timestamp}] {message}\n" if message else "\n"
            combined_msg = f"[{timestamp}] [{self.label_for(source)}] {message}\n" if message else "\n"

            if source == SYSTEM_SOURCE:
                self.text_system.insert(tk.END, formatted_msg)
                touched.add(self.text_system)
            else:
                area = self.device_text_areas.get(source)
                if area is None:
                    area = self.ensure_device_tab(source)
                area.insert(tk.END, formatted_msg)
                touched.add(area)

            self.text_combined.insert(tk.END, combined_msg, source)
            touched.add(self.text_combined)

        for widget in touched:
            self._trim(widget)
            widget.see(tk.END)

        # Come back immediately when there is still a backlog, so a burst drains fast without
        # the UI ever blocking on it.
        self.root.after(10 if drained >= MAX_LINES_PER_TICK else 100, self.process_log_queue)

    def clear_displays(self) -> None:
        self.text_combined.delete("1.0", tk.END)
        self.text_system.delete("1.0", tk.END)
        for text_area in self.device_text_areas.values():
            text_area.delete("1.0", tk.END)
        self.log(SYSTEM_SOURCE, "Affichages effacés.")

    def save_logs(self) -> None:
        """Writes the combined tab to a file - the runbook wants the log lines, not a summary."""
        default_name = f"canari-logcat-{datetime.datetime.now():%Y%m%d-%H%M%S}.log"
        path = filedialog.asksaveasfilename(
            title="Enregistrer les logs combinés",
            defaultextension=".log",
            initialfile=default_name,
            filetypes=[("Fichier log", "*.log"), ("Tous les fichiers", "*.*")],
        )
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(self.text_combined.get("1.0", tk.END))
            self.log(SYSTEM_SOURCE, f"Logs enregistrés : {path}")
        except Exception as e:
            self.log(SYSTEM_SOURCE, f"Échec de l'enregistrement : {e}")

    # === DEVICES ===
    def refresh_devices(self) -> None:
        """Re-detects devices and updates the buttons and tabs to match."""
        self.log(SYSTEM_SOURCE, "Détection des appareils…")

        def worker():
            new_devices = detect_devices()

            def update_ui():
                added = [d for d in new_devices if d not in self.devices]
                removed = [d for d in self.devices if d not in new_devices]

                if not added and not removed:
                    self.log(SYSTEM_SOURCE, f"Aucun changement ({len(new_devices)} appareil(s)).")
                    return

                for device_id in removed:
                    self.log(SYSTEM_SOURCE, f"Déconnecté : {self.devices[device_id]} ({device_id})")
                    self.stop_logcat_for_device(device_id, quiet=True)

                self.devices = new_devices

                for device_id in added:
                    self.log(SYSTEM_SOURCE, f"Connecté : {self.devices[device_id]} ({device_id})")
                    self.ensure_device_tab(device_id)

                self.rebuild_device_buttons()
                self.log(SYSTEM_SOURCE, f"{len(self.devices)} appareil(s) connecté(s).")

            self.root.after(0, update_ui)

        threading.Thread(target=worker, daemon=True).start()

    def force_stop_all(self) -> None:
        """`am force-stop` on every device - how the runbook means "kill the app"."""
        if not self.devices:
            self.log(SYSTEM_SOURCE, "Aucun appareil connecté.")
            return

        def task():
            for device_id, device_name in list(self.devices.items()):
                try:
                    _run(["adb", "-s", device_id, "shell", "am", "force-stop", PACKAGE_NAME], timeout=15)
                    self.log(SYSTEM_SOURCE, f"{PACKAGE_NAME} arrêté sur {device_name}.")
                except Exception as e:
                    self.log(SYSTEM_SOURCE, f"Échec de l'arrêt sur {device_name} : {e}")

        threading.Thread(target=task, daemon=True).start()

    # === PROCESS CONTROL ===
    def stop_all_processes(self) -> None:
        """Interrupts builds and deploys. Logcat has its own button and is left alone."""
        with self.process_lock:
            running = [p for p in self.current_processes if p.poll() is None]

        if not running:
            self.log(SYSTEM_SOURCE, "Aucune compilation ou installation en cours.")
            return

        self.log(SYSTEM_SOURCE, f"Interruption de {len(running)} processus…")
        for p in running:
            try:
                p.terminate()
            except Exception as e:
                self.log(SYSTEM_SOURCE, f"Échec de l'interruption : {e}")

        self.root.after(2000, self._force_kill_remaining)

    def _force_kill_remaining(self) -> None:
        """Kills whatever ignored the terminate."""
        with self.process_lock:
            survivors = [p for p in self.current_processes if p.poll() is None]
        for p in survivors:
            try:
                p.kill()
            except Exception:
                pass
        if survivors:
            self.log(SYSTEM_SOURCE, f"{len(survivors)} processus tué(s) de force.")

    def _track(self, process: subprocess.Popen[str]) -> None:
        with self.process_lock:
            self.current_processes.append(process)

    def _untrack(self, process: subprocess.Popen[str]) -> None:
        with self.process_lock:
            if process in self.current_processes:
                self.current_processes.remove(process)

    # === COMMANDS (worker threads) ===
    def execute_command(
        self, cmd: str, source_name: str, success_msg: Optional[str] = None, cwd: Optional[str] = None
    ) -> bool:
        """Runs a shell command, streaming its output. Returns True on exit code 0."""
        if cwd is None:
            cwd = PROJECT_DIR

        self.log(SYSTEM_SOURCE, f"> {cmd}")
        process = None
        try:
            env = os.environ.copy()
            if ANDROID_HOME:
                env["ANDROID_HOME"] = ANDROID_HOME

            # shell=True so Windows resolves "bun" and "adb" through PATHEXT.
            process = subprocess.Popen(
                cmd,
                cwd=cwd,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
            )
            self._track(process)

            if process.stdout:
                for line in process.stdout:
                    self.log(source_name, line)

            process.wait()

            if process.returncode == 0:
                if success_msg:
                    self.log(SYSTEM_SOURCE, success_msg)
                return True
            if process.returncode in (-15, -9):  # SIGTERM / SIGKILL: we asked for it
                self.log(SYSTEM_SOURCE, "Processus interrompu.")
                return False
            self.log(SYSTEM_SOURCE, f"ÉCHEC (code {process.returncode}) : {cmd}")
            return False
        except Exception as e:
            self.log(SYSTEM_SOURCE, f"Exception : {e}")
            return False
        finally:
            if process is not None:
                self._untrack(process)

    def execute_command_list(
        self, cmd: list[str], source_name: str, success_msg: Optional[str] = None, cwd: Optional[str] = None
    ) -> bool:
        """Same, with an argv list (shell=False) - avoids Windows quoting problems."""
        if cwd is None:
            cwd = PROJECT_DIR

        self.log(SYSTEM_SOURCE, f"> {' '.join(cmd)}")
        process = None
        try:
            process = subprocess.Popen(
                cmd,
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=_NO_WINDOW,
            )
            self._track(process)

            if process.stdout:
                for line in process.stdout:
                    self.log(source_name, line)

            process.wait()

            if process.returncode == 0:
                if success_msg:
                    self.log(SYSTEM_SOURCE, success_msg)
                return True
            if process.returncode in (-15, -9):
                self.log(SYSTEM_SOURCE, "Processus interrompu.")
                return False
            self.log(SYSTEM_SOURCE, f"ÉCHEC (code {process.returncode}) : {' '.join(cmd)}")
            return False
        except Exception as e:
            self.log(SYSTEM_SOURCE, f"Exception : {e}")
            return False
        finally:
            if process is not None:
                self._untrack(process)

    def run_build(self) -> None:
        def build_task() -> None:
            self.log(SYSTEM_SOURCE, "--- NETTOYAGE ---")
            cargo_manifest = os.path.join(PROJECT_DIR, "src-tauri", "Cargo.toml")
            self.execute_command(f'cargo clean --manifest-path "{cargo_manifest}"', SYSTEM_SOURCE)

            # aarch64 only: faster, and it avoids the Gradle 9.1 universal-APK bug.
            self.log(SYSTEM_SOURCE, "--- COMPILATION (debug, aarch64) ---")
            ok = self.execute_command(
                "bun tauri android build --target aarch64 --debug",
                SYSTEM_SOURCE,
                "Compilation terminée (mode DEBUG).",
                cwd=PROJECT_DIR,
            )
            if not ok:
                self.log(SYSTEM_SOURCE, "Compilation échouée - installation annulée.")
                return

            self._ensure_native_lib_present()

            apk = find_apk(PROJECT_DIR)
            if apk:
                self.log(SYSTEM_SOURCE, f"APK produit : {apk}")
            else:
                self.log(SYSTEM_SOURCE, "Aucun APK trouvé dans les sorties de build.")

        threading.Thread(target=build_task, daemon=True).start()

    def _ensure_native_lib_present(self) -> None:
        """Copies the Rust .so into jniLibs when the build could not link it.

        Some Android build steps create symlinks, which fail on Windows without developer
        mode - the .so is built but never lands in jniLibs, and the APK assembles without it.
        """
        try:
            import shutil

            so_src = os.path.join(
                PROJECT_DIR, "src-tauri", "target", "aarch64-linux-android", "debug", "libmines_app_lib.so"
            )
            so_dst_dir = os.path.join(
                PROJECT_DIR, "src-tauri", "gen", "android", "app", "src", "main", "jniLibs", "arm64-v8a"
            )
            so_dst = os.path.join(so_dst_dir, "libmines_app_lib.so")

            if not os.path.isfile(so_src):
                self.log(SYSTEM_SOURCE, "Librairie native .so introuvable dans target/ - build incomplet ?")
                return

            if os.path.isfile(so_dst) and os.path.getmtime(so_dst) >= os.path.getmtime(so_src):
                self.log(SYSTEM_SOURCE, "Librairie native déjà à jour dans jniLibs.")
                return

            os.makedirs(so_dst_dir, exist_ok=True)
            shutil.copy2(so_src, so_dst)
            self.log(SYSTEM_SOURCE, f"Librairie native copiée vers {so_dst}")
        except Exception as e:
            self.log(SYSTEM_SOURCE, f"Échec de la copie de la librairie native : {e}")

    def run_deploy(self, device_id: str) -> None:
        device_name = self.devices.get(device_id, device_id)
        clean = self.clean_install_var.get()
        self.log(SYSTEM_SOURCE, f"--- DÉPLOIEMENT SUR {device_name} ---")

        def task() -> None:
            abi = device_abi(device_id)
            apk_full = find_apk(PROJECT_DIR, abi)
            if not apk_full:
                self.log(
                    SYSTEM_SOURCE,
                    f"Aucun APK debug compatible {abi or 'arm64-v8a'} pour {device_name}. Compilez d'abord.",
                )
                return
            self.log(SYSTEM_SOURCE, f"ABI {abi or 'inconnue'} -> {os.path.relpath(apk_full, PROJECT_DIR)}")

            if clean:
                self.log(SYSTEM_SOURCE, f"Désinstallation de {PACKAGE_NAME} (les données seront perdues)…")
                result = _run(["adb", "-s", device_id, "uninstall", PACKAGE_NAME], timeout=60)
                if "Success" in result.stdout:
                    self.log(SYSTEM_SOURCE, "Désinstallé.")
                else:
                    # Distinguish "was not installed" from "adb could not talk to the device":
                    # the second one used to be reported as the first.
                    detail = (result.stdout + result.stderr).strip().splitlines()
                    reason = detail[-1] if detail else "raison inconnue"
                    self.log(SYSTEM_SOURCE, f"Rien à désinstaller ({reason}).")

            # -r reinstalls while keeping the data; -d allows a downgrade.
            install_args = ["adb", "-s", device_id, "install", "-r", "-d", apk_full]
            if clean:
                install_args = ["adb", "-s", device_id, "install", apk_full]

            self.log(SYSTEM_SOURCE, f"Installation de {os.path.basename(apk_full)}…")
            if not self.execute_command_list(install_args, SYSTEM_SOURCE, f"APK installé sur {device_name}"):
                self.log(SYSTEM_SOURCE, "Installation échouée - lancement annulé.")
                return

            # Logcat starts BEFORE the app, so the launch itself is captured.
            self.start_logcat_for_device(device_id)

            if not self.execute_command_list(
                ["adb", "-s", device_id, "shell", "am", "start", "-n", ACTIVITY_NAME],
                SYSTEM_SOURCE,
                f"Application lancée sur {device_name}",
            ):
                self.log(SYSTEM_SOURCE, "Lancement échoué.")

        threading.Thread(target=task, daemon=True).start()

    def deploy_all(self) -> None:
        for device_id in list(self.devices):
            self.run_deploy(device_id)

    # === LOGCAT ===
    def start_logcat_for_device(self, device_id: str) -> None:
        """Starts (or restarts) the logcat reader for one device.

        Any logcat already running on this device is stopped first. Without that, deploying
        twice - or deploying after pressing "Lancer Logcat" - left two readers alive on the
        same device and every line appeared twice.
        """
        device_name = self.devices.get(device_id, device_id)
        self.stop_logcat_for_device(device_id, quiet=True)

        try:
            _run(["adb", "-s", device_id, "logcat", "-c"], timeout=15)
        except Exception as e:
            self.log(SYSTEM_SOURCE, f"Impossible d'effacer le buffer logcat de {device_name} : {e}")

        # shell=False + argv list: cmd.exe eats the quotes around logcat filters otherwise,
        # and the filters are then silently ignored. `*:S` silences everything not whitelisted.
        cmd = ["adb", "-s", device_id, "logcat", "*:S", *LOGCAT_TAGS]

        try:
            process = subprocess.Popen(
                cmd,
                cwd=PROJECT_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=_NO_WINDOW,
            )
        except Exception as e:
            self.log(SYSTEM_SOURCE, f"Échec du démarrage de logcat sur {device_name} : {e}")
            return

        with self.process_lock:
            self.logcat_processes[device_id] = process

        self.log(SYSTEM_SOURCE, f"Logcat démarré sur {device_name} ({len(LOGCAT_TAGS)} tags).")

        def read_output() -> None:
            if not process.stdout:
                return
            for line in process.stdout:
                # A reader whose process has been replaced must stop writing, or a restart
                # brings the duplicates back through the thread that was left behind.
                with self.process_lock:
                    if self.logcat_processes.get(device_id) is not process:
                        return
                parsed = parse_logcat_line(line)
                if parsed is not None:
                    self.log(device_id, parsed)

        threading.Thread(target=read_output, daemon=True).start()

    def stop_logcat_for_device(self, device_id: str, quiet: bool = False) -> bool:
        """Stops the logcat of one device. Returns True if one was running."""
        with self.process_lock:
            process = self.logcat_processes.pop(device_id, None)
        if process is None:
            return False
        try:
            process.kill()
        except Exception:
            pass
        if not quiet:
            self.log(SYSTEM_SOURCE, f"Logcat arrêté sur {self.label_for(device_id)}.")
        return True

    def start_all_logcats(self) -> None:
        if not self.devices:
            self.log(SYSTEM_SOURCE, "Aucun appareil connecté.")
            return
        for device_id in list(self.devices):
            self.start_logcat_for_device(device_id)

    def stop_all_logcats(self) -> None:
        with self.process_lock:
            device_ids = list(self.logcat_processes)
        stopped = sum(1 for device_id in device_ids if self.stop_logcat_for_device(device_id, quiet=True))
        if stopped:
            self.log(SYSTEM_SOURCE, f"{stopped} logcat(s) arrêté(s).")
        else:
            self.log(SYSTEM_SOURCE, "Aucun logcat en cours.")

    def on_closing(self) -> None:
        """Kills every child process on exit, builds included."""
        with self.process_lock:
            processes = list(self.logcat_processes.values()) + list(self.current_processes)
            self.logcat_processes.clear()
            self.current_processes.clear()
        for p in processes:
            try:
                p.kill()
            except Exception:
                pass
        self.root.destroy()
        sys.exit()


if __name__ == "__main__":
    setup_android_environment()
    root = tk.Tk()
    app = TauriManagerApp(root)
    root.mainloop()
