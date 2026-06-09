# -*- coding: utf-8 -*-
import tkinter as tk
from tkinter import ttk, scrolledtext, filedialog, messagebox
import subprocess
import threading
import queue
import datetime
import sys
import re
import os
from typing import Optional

# === CONFIGURATION PAR DÉFAUT ===
# Chemins relatifs au répertoire du script (adaptable)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PROJECT_DIR = os.path.join(SCRIPT_DIR, "frontend")
DEFAULT_APK_PATH = r"src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk"
DEFAULT_PACKAGE_NAME = "fr.emse.canari"
DEFAULT_ACTIVITY_NAME = f"{DEFAULT_PACKAGE_NAME}/.MainActivity"

# Stockage de la configuration (au démarrage)
PROJECT_DIR = DEFAULT_PROJECT_DIR
APK_PATH = DEFAULT_APK_PATH
PACKAGE_NAME = DEFAULT_PACKAGE_NAME
ACTIVITY_NAME = DEFAULT_ACTIVITY_NAME
DETECTED_DEVICES: dict[str, str] = {}  # {device_id: device_name}
ANDROID_HOME: str = ""  # Sera configuré au démarrage

def find_android_sdk() -> Optional[str]:
    """Cherche le SDK Android aux emplacements standards."""
    possible_paths = [
        os.path.expanduser("~\\AppData\\Local\\Android\\Sdk"),  # Android Studio par défaut
        "C:\\Android\\Sdk",  # Installation manuelle
        os.environ.get("ANDROID_HOME", ""),  # Variable d'environnement
    ]

    for path in possible_paths:
        if path and os.path.isdir(path):
            # Vérifier qu'il contient les outils essentiels ou les nouveaux CLI
            essentials = [
                os.path.join(path, "tools"),
                os.path.join(path, "platform-tools"),
                os.path.join(path, "cmdline-tools"),
                os.path.join(path, "platforms"),
                os.path.join(path, "build-tools"),
            ]
            for e in essentials:
                if os.path.isdir(e):
                    return path

    return None

def setup_android_environment() -> str:
    """Configure ANDROID_HOME et retourne le chemin du SDK."""
    global ANDROID_HOME

    # Étape 1 : Chercher automatiquement
    found_sdk = find_android_sdk()
    if found_sdk:
        ANDROID_HOME = found_sdk
        print(f"[OK] Android SDK trouve: {ANDROID_HOME}")
        return ANDROID_HOME

    # Étape 2 : Afficher un message d'erreur informatif
    print("[ERROR] Android SDK non trouve!")
    print("[INFO] Emplacements attendus:")
    print("  - C:\\Users\\<username>\\AppData\\Local\\Android\\Sdk (Android Studio)")
    print("  - C:\\Android\\Sdk (installation manuelle)")
    print("[INFO] Configurez ANDROID_HOME manuellement ou installez Android Studio.")

    return ""

def download_android_cli_tools() -> bool:
    """Télécharge et extrait les Android CLI Tools automatiquement."""
    import zipfile
    import shutil
    from urllib.request import urlopen

    print("[INFO] Telechargement des Android CLI Tools...")

    # URL officielle des CLI Tools (Windows 64-bit)
    cli_tools_url = "https://dl.google.com/android/repository/commandlinetools-win-10406996_latest.zip"

    sdk_base = os.path.expanduser("~\\AppData\\Local\\Android\\Sdk")
    cmdline_tools_path = os.path.join(sdk_base, "cmdline-tools")
    latest_path = os.path.join(cmdline_tools_path, "latest")

    # Créer les répertoires
    os.makedirs(cmdline_tools_path, exist_ok=True)

    zip_path = os.path.join(sdk_base, "cmdlinetools.zip")

    try:
        # Télécharger
        print(f"[INFO] Telechargement depuis: {cli_tools_url}")
        with urlopen(cli_tools_url) as response:
            total_size = int(response.headers.get('content-length', 0))
            downloaded = 0
            chunk_size = 8192

            with open(zip_path, 'wb') as f:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        percent = (downloaded / total_size) * 100
                        print(f"[INFO] Progres: {percent:.1f}%", end='\r')

        print("[OK] Telechargement complete")

        # Extraire
        print("[INFO] Extraction des fichiers...")
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(cmdline_tools_path)

        # Renommer cmdline-tools -> latest
        extracted_path = os.path.join(cmdline_tools_path, "cmdline-tools")
        if os.path.exists(extracted_path):
            if os.path.exists(latest_path):
                shutil.rmtree(latest_path)
            shutil.move(extracted_path, latest_path)

        # Nettoyer le zip
        os.remove(zip_path)

        print(f"[OK] Android CLI Tools extrait dans: {latest_path}")
        return True

    except Exception as e:
        print(f"[ERROR] Echec du telechargement des CLI Tools: {e}")
        if os.path.exists(zip_path):
            os.remove(zip_path)
        return False

def install_android_sdk() -> bool:
    """Tente d'installer le SDK Android via sdkmanager si disponible."""
    import shutil

    print("[INFO] Tentative d'installation du SDK Android...")

    # Chercher sdkmanager dans les emplacements standards
    possible_sdkmanager_paths = [
        os.path.expanduser("~\\AppData\\Local\\Android\\Sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat"),
        "C:\\Android\\Sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat",
    ]

    sdkmanager_path = None
    for path in possible_sdkmanager_paths:
        if os.path.isfile(path):
            sdkmanager_path = path
            break

    # Si sdkmanager n'existe pas, télécharger les CLI Tools
    if not sdkmanager_path:
        print("[INFO] sdkmanager non trouve. Telechargement des Android CLI Tools...")
        if not download_android_cli_tools():
            print("[ERROR] Impossible de telecharger les CLI Tools")
            return False

        # Vérifier que sdkmanager existe maintenant
        sdkmanager_path = os.path.expanduser("~\\AppData\\Local\\Android\\Sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat")
        if not os.path.isfile(sdkmanager_path):
            print("[ERROR] sdkmanager toujours introuvable apres le telechargement")
            return False

    try:
        print(f"[INFO] Utilisation de sdkmanager: {sdkmanager_path}")

        # Définir ANDROID_HOME pour sdkmanager
        android_home = os.path.dirname(os.path.dirname(os.path.dirname(sdkmanager_path)))
        env = os.environ.copy()
        env["ANDROID_HOME"] = android_home

        print(f"[INFO] ANDROID_HOME={android_home}")

        # Accepter les licenses automatiquement (requis par sdkmanager)
        print("[INFO] Acceptation des licenses Android...")
        licenses_result = subprocess.run(
            [sdkmanager_path, "--licenses"],
            input="y\n" * 10,  # Répond "y" à chaque prompt de license
            capture_output=True,
            text=True,
            timeout=120,
            env=env
        )
        print("[OK] Licenses acceptees")

        # Installer les packages essentiels
        packages = [
            "platforms;android-34",
            "build-tools;34.0.0",
            "ndk;26.1.10909125",
        ]

        for package in packages:
            print(f"[INFO] Installation de {package}...")

            result = subprocess.run(
                [sdkmanager_path, package],
                capture_output=True,
                text=True,
                timeout=600,
                env=env
            )

            if result.returncode != 0:
                print(f"[WARN] Echec de l'installation de {package}")
                if result.stderr:
                    print(f"       Erreur: {result.stderr[:200]}")
            else:
                print(f"[OK] {package} installe")

        print("[OK] Installation du SDK Android completee")
        return True

    except subprocess.TimeoutExpired:
        print("[ERROR] Installation du SDK Android timeout (> 10 minutes)")
        return False
    except Exception as e:
        print(f"[ERROR] Erreur lors de l'installation du SDK Android: {e}")
        return False

def strip_ansi(text: str) -> str:
    """Supprime les codes d'échappement ANSI de la chaîne."""
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    return ansi_escape.sub('', text)

def detect_devices() -> dict[str, str]:
    """Détecte les appareils Android connectés via ADB. Retourne {device_id: device_model}."""
    devices = {}
    try:
        # Étape 1 : Démarrer le serveur ADB (important sur Windows)
        print("[INFO] Demarrage du serveur ADB...")
        start_result = subprocess.run(
            ['adb', 'start-server'],
            capture_output=True,
            text=True,
            encoding='utf-8',
            timeout=10
        )

        # Étape 2 : Lister les appareils (avec timeout plus long)
        print("[INFO] Detection des appareils...")
        result = subprocess.run(
            ['adb', 'devices', '-l'],
            capture_output=True,
            text=True,
            encoding='utf-8',
            timeout=30  # 30 secondes pour la première détection
        )

        lines = result.stdout.strip().split('\n')[1:]  # Saute la première ligne "List of devices attached"
        for line in lines:
            line = line.strip()
            if not line:
                continue
            # Détecte les appareils (status = "device", pas "offline" ou "unauthorized")
            if 'device' in line and 'offline' not in line and 'unauthorized' not in line:
                parts = line.split()
                if len(parts) >= 2:
                    device_id = parts[0]
                    # Extrait le modèle de l'appareil (model:)
                    model = "Appareil"
                    for part in parts:
                        if part.startswith('model:'):
                            model = part[6:]  # Retire "model:"
                            break
                    devices[device_id] = model or device_id
                    print(f"  [OK] {model} ({device_id})")

        if not devices:
            print("[WARN] Aucun appareil detecte (verifiez les connexions USB et les autorisations)")

    except subprocess.TimeoutExpired:
        print("[TIMEOUT] Detection ADB (serveur lent a demarrer). Reessayez...")
    except FileNotFoundError:
        print("[ERROR] ADB non trouve. Installez le SDK Platform-Tools Android.")
    except Exception as e:
        print(f"[ERROR] Erreur lors de la detection des appareils: {e}")

    return devices

# Lignes logcat à supprimer entièrement (polling heartbeat, bruit récurrent)
_MUTE_RE: list[re.Pattern[str]] = [
    re.compile(r'\[API\] [→←].*/api/presence'),
    # Ajouter ici d'autres patterns bruyants si besoin
]

_LOGCAT_LINE_RE = re.compile(
    r'\d{2}-\d{2} (\d{2}:\d{2}:\d{2})\.\d{3}\s+\d+\s+\d+\s+\w+\s+([^:]+):\s+(.*)'
)
_TAURI_MSG_RE = re.compile(r'Msg:\s+(.*)')

def parse_logcat_line(raw: str) -> Optional[str]:
    """Extrait timestamp + message utile ; retourne None pour supprimer la ligne."""
    line = strip_ansi(raw.strip())
    if not line:
        return None

    m = _LOGCAT_LINE_RE.match(line)
    if not m:
        return line  # ligne non reconnue : garder telle quelle

    time_str, tag, msg = m.group(1), m.group(2).strip(), m.group(3)

    if 'Tauri/Console' in tag:
        tm = _TAURI_MSG_RE.search(msg)
        if tm:
            msg = tm.group(1)
    else:
        msg = f"[{tag}] {msg}"

    for pattern in _MUTE_RE:
        if pattern.search(msg):
            return None

    return f"{time_str} {msg}"

class TauriManagerApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root: tk.Tk = root
        self.root.title("Gestionnaire Tauri Android - Canari")
        self.root.geometry("1600x900")
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)

        # File d'attente pour la communication entre les threads et l'interface graphique
        self.log_queue: queue.Queue[tuple[str, str, str]] = queue.Queue()
        self.logcat_processes: list[subprocess.Popen[str]] = []
        self.current_processes: list[subprocess.Popen[str]] = []  # Processus en cours (compilation, deployment)

        # Configuration
        self.devices: dict[str, str] = {}  # {device_id: device_model}
        self.selected_device_ids: list[str] = []  # IDs des appareils sélectionnés
        self.device_buttons: dict[str, ttk.Button] = {}  # Boutons des appareils pour MAJ dynamique

        # Masque la fenêtre principale et affiche d'abord la fenêtre de configuration
        self.root.withdraw()
        self.show_config_window()

    def show_config_window(self) -> None:
        """Fenêtre de configuration initiale."""
        global ANDROID_HOME

        config_win = tk.Toplevel(self.root)
        config_win.title("Configuration initiale")
        config_win.geometry("600x450")
        config_win.transient(self.root)
        config_win.grab_set()

        ttk.Label(config_win, text="Chemin du projet frontend :", font=("Segoe UI", 10)).pack(pady=(10, 5), padx=10, anchor=tk.W)

        path_frame = ttk.Frame(config_win)
        path_frame.pack(pady=5, padx=10, fill=tk.X)

        path_var = tk.StringVar(value=PROJECT_DIR)
        path_entry = ttk.Entry(path_frame, textvariable=path_var, width=50)
        path_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))

        def browse_path():
            selected = filedialog.askdirectory(title="Selectionnez le repertoire frontend", initialdir=PROJECT_DIR)
            if selected:
                path_var.set(selected)

        ttk.Button(path_frame, text="Parcourir...", command=browse_path).pack(side=tk.LEFT)

        # --- Section Android SDK ---
        ttk.Label(config_win, text="Android SDK :", font=("Segoe UI", 10, "bold")).pack(pady=(15, 5), padx=10, anchor=tk.W)

        android_frame = ttk.Frame(config_win)
        android_frame.pack(pady=5, padx=10, fill=tk.X)

        android_var = tk.StringVar(value=ANDROID_HOME or "(non detecte)")
        android_entry = ttk.Entry(android_frame, textvariable=android_var, width=50)
        android_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))

        def browse_android():
            selected = filedialog.askdirectory(
                title="Selectionnez le repertoire Android SDK",
                initialdir=os.path.expanduser("~\\AppData\\Local\\Android")
            )
            if selected:
                android_var.set(selected)

        ttk.Button(android_frame, text="Parcourir...", command=browse_android).pack(side=tk.LEFT, padx=(0, 5))

        sdk_status_label = ttk.Label(config_win, text="", foreground="gray", font=("Segoe UI", 9))
        sdk_status_label.pack(pady=2, padx=10, anchor=tk.W)

        def check_android_sdk():
            sdk_path = android_var.get()
            if sdk_path and sdk_path != "(non detecte)":
                if os.path.isdir(sdk_path):
                    sdk_status_label.config(text="[OK] SDK Android valide", foreground="green")
                else:
                    sdk_status_label.config(text="[ERREUR] Repertoire invalide", foreground="red")
            else:
                found = find_android_sdk()
                if found:
                    android_var.set(found)
                    sdk_status_label.config(text="[OK] SDK Android detecte automatiquement", foreground="green")
                else:
                    sdk_status_label.config(
                        text="[WARN] Android SDK non trouve. Installez Android Studio ou configurez manuellement.",
                        foreground="orange"
                    )

        def install_sdk_button():
            sdk_status_label.config(text="[INFO] Installation en cours... (peut prendre 5-10 minutes)", foreground="blue")
            config_win.update()

            def install_task():
                result = install_android_sdk()
                if result:
                    found = find_android_sdk()
                    if found:
                        android_var.set(found)
                def update_ui():
                    if result:
                        sdk_status_label.config(
                            text="[OK] SDK Android installe! Redemarrez l'application.",
                            foreground="green"
                        )
                    else:
                        sdk_status_label.config(
                            text="[ERROR] Installation du SDK echouee. Voir console pour details.",
                            foreground="red"
                        )
                config_win.after(100, update_ui)

            threading.Thread(target=install_task, daemon=True).start()

        sdk_buttons_frame = ttk.Frame(config_win)
        sdk_buttons_frame.pack(pady=5, padx=10, fill=tk.X)
        ttk.Button(sdk_buttons_frame, text="Verifier SDK Android", command=check_android_sdk).pack(side=tk.LEFT, padx=5)
        ttk.Button(sdk_buttons_frame, text="Installer SDK Android", command=install_sdk_button).pack(side=tk.LEFT, padx=5)

        ttk.Label(config_win, text="Appareils detectes :", font=("Segoe UI", 10)).pack(pady=(10, 5), padx=10, anchor=tk.W)

        device_frame = ttk.Frame(config_win)
        device_frame.pack(pady=5, padx=10, fill=tk.BOTH, expand=True)

        scrollbar = ttk.Scrollbar(device_frame)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        device_listbox = tk.Listbox(device_frame, yscrollcommand=scrollbar.set, height=6)
        device_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.config(command=device_listbox.yview)

        status_label = ttk.Label(config_win, text="", foreground="gray")
        status_label.pack(pady=5, padx=10, anchor=tk.W)

        def detect_and_refresh():
            device_listbox.delete(0, tk.END)
            status_label.config(text="[INFO] Detection en cours (peut prendre 10-30 secondes)...", foreground="blue")
            config_win.update()

            detected = detect_devices()

            if detected:
                for dev_id, dev_name in detected.items():
                    device_listbox.insert(tk.END, f"OK {dev_name} ({dev_id})")
                status_label.config(text=f"[OK] {len(detected)} appareil(s) detecte(s)", foreground="green")
            else:
                device_listbox.insert(tk.END, "[WARN] Aucun appareil detecte")
                status_label.config(
                    text="[INFO] Verifiez: USB, Developer Mode, USB Debugging, autorisations ADB",
                    foreground="orange"
                )

        button_frame = ttk.Frame(config_win)
        button_frame.pack(pady=10, padx=10, fill=tk.X)

        ttk.Button(button_frame, text="Detecter appareils", command=detect_and_refresh).pack(side=tk.LEFT, padx=5)

        def confirm():
            global PROJECT_DIR, ANDROID_HOME
            project_path = path_var.get()
            if not os.path.isdir(project_path):
                messagebox.showerror("Erreur", f"Repertoire invalide : {project_path}")
                return

            android_path = android_var.get()
            if android_path and android_path != "(non detecte)" and not os.path.isdir(android_path):
                messagebox.showerror("Erreur", f"Android SDK invalide : {android_path}")
                return

            PROJECT_DIR = project_path
            ANDROID_HOME = android_path if android_path and android_path != "(non detecte)" else ""

            self.devices = detect_devices()
            self.selected_device_ids = list(self.devices.keys())

            if not self.selected_device_ids:
                result = messagebox.askyesno(
                    "Aucun appareil",
                    "Aucun appareil detecte.\nContinuer quand meme pour compiler uniquement ?"
                )
                if not result:
                    return

            config_win.destroy()
            # Montrer la fenêtre principale et initialiser l'UI
            self.root.deiconify()
            self.setup_ui()
            self.root.after(100, self.process_log_queue)

        ttk.Button(button_frame, text="Confirmer et continuer", command=confirm).pack(side=tk.RIGHT, padx=5)

        # Verifications initiales (en arriere-plan)
        def initial_checks():
            check_android_sdk()
            detect_and_refresh()
        threading.Thread(target=initial_checks, daemon=True).start()

        # Assure que la fenêtre est bien visible ; sinon affiche une fenêtre de secours
        def ensure_visible():
            try:
                # Bring to front and check mapping
                config_win.lift()
                config_win.focus_force()
                if not config_win.winfo_ismapped():
                    print("[WARN] La fenêtre de configuration n'est pas visible, affichage de secours.")
                    try:
                        config_win.deiconify()
                    except Exception:
                        pass
                    try:
                        self.root.deiconify()
                    except Exception:
                        pass
                else:
                    # ensure focused
                    config_win.focus_force()
            except Exception as e:
                print(f"[ERROR] Erreur lors de la vérification de visibilité: {e}")

        config_win.after(2000, ensure_visible)
    def setup_ui(self) -> None:
        # --- Cadre des Contrôles ---
        control_frame = ttk.LabelFrame(self.root, text="Actions", padding=(10, 5))
        control_frame.pack(fill=tk.X, padx=10, pady=5)

        ttk.Button(control_frame, text="1. Compiler (Bun)", command=self.run_build).pack(side=tk.LEFT, padx=5)

        # Boutons dynamiques pour chaque appareil détecté
        for device_id, device_name in self.devices.items():
            btn = ttk.Button(
                control_frame,
                text=f"2. Installer & Lancer ({device_name})",
                command=lambda did=device_id, dname=device_name: self.run_deploy(did, dname)
            )
            btn.pack(side=tk.LEFT, padx=5)
            self.device_buttons[device_id] = btn

        if self.selected_device_ids:
            ttk.Button(control_frame, text="Tout Installer & Lancer", command=self.deploy_all).pack(side=tk.LEFT, padx=5)

        ttk.Separator(control_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=10)

        ttk.Button(control_frame, text="Lancer Logcat", command=self.start_all_logcats).pack(side=tk.LEFT, padx=5)
        ttk.Button(control_frame, text="Arrêter Logcat", command=self.stop_all_logcats).pack(side=tk.LEFT, padx=5)

        ttk.Separator(control_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=10)

        ttk.Button(control_frame, text="🔄 Détecter appareils", command=self.refresh_devices).pack(side=tk.LEFT, padx=5)

        # Bouton Stop avec style rouge
        stop_button = ttk.Button(control_frame, text="⏹️ STOP", command=self.stop_all_processes)
        stop_button.pack(side=tk.LEFT, padx=5)

        ttk.Button(control_frame, text="Effacer les affichages", command=self.clear_displays).pack(side=tk.RIGHT, padx=5)

        # --- Cadre des Logs (Onglets) ---
        notebook = ttk.Notebook(self.root)
        notebook.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        # Onglet Système toujours présent
        self.text_system: scrolledtext.ScrolledText = scrolledtext.ScrolledText(notebook, wrap=tk.WORD, bg="#1e1e1e", fg="#ce9178", font=("Consolas", 10))
        notebook.add(self.text_system, text="⚙️ Système (Compilation/Infos)")

        # Onglets dynamiques pour chaque appareil
        self.device_text_areas: dict[str, scrolledtext.ScrolledText] = {}
        if len(self.devices) == 1:
            # Un seul appareil : affichage full-width
            device_id, device_name = list(self.devices.items())[0]
            text_area = scrolledtext.ScrolledText(notebook, wrap=tk.WORD, bg="#1e1e1e", fg="#569cd6", font=("Consolas", 9))
            notebook.add(text_area, text=f"📱 {device_name}")
            self.device_text_areas[device_name] = text_area
        elif len(self.devices) >= 2:
            # Deux appareils ou plus : affichage côte à côte
            monitoring_frame = ttk.Frame(notebook)
            notebook.add(monitoring_frame, text="📱 Suivi Temps Réel")

            paned: ttk.PanedWindow = ttk.PanedWindow(monitoring_frame, orient=tk.HORIZONTAL)
            paned.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

            for idx, (device_id, device_name) in enumerate(list(self.devices.items())[:2]):  # Max 2 appareils côte à côte
                color = "#569cd6" if idx == 0 else "#4ec9b0"
                device_frame: ttk.LabelFrame = ttk.LabelFrame(paned, text=f"📱 {device_name}", padding=5)
                paned.add(device_frame)  # type: ignore
                text_area: scrolledtext.ScrolledText = scrolledtext.ScrolledText(device_frame, wrap=tk.WORD, bg="#1e1e1e", fg=color, font=("Consolas", 9))
                text_area.pack(fill=tk.BOTH, expand=True)
                self.device_text_areas[device_name] = text_area

        # Onglet combiné
        self.text_combined: scrolledtext.ScrolledText = scrolledtext.ScrolledText(notebook, wrap=tk.WORD, bg="#1e1e1e", fg="#d4d4d4", font=("Consolas", 10))
        notebook.add(self.text_combined, text="📋 Logs Combinés")

        # Configuration des tags de couleurs
        for device_id, device_name in self.devices.items():
            self.text_combined.tag_config(device_name, foreground="#569cd6")
        self.text_combined.tag_config("Système", foreground="#ce9178")

    # === LOGIQUE D'AFFICHAGE ===
    def refresh_devices(self) -> None:
        """Détecte les appareils et met à jour l'interface."""
        self.log("Système", "🔄 Détection des appareils...")
        new_devices = detect_devices()
        if new_devices == self.devices:
            self.log("Système", "Aucun changement détecté.")
            return

        self.devices = new_devices
        self.selected_device_ids = list(self.devices.keys())
        self.log("Système", f"✅ {len(self.devices)} appareil(s) détecté(s)")
        for dev_id, dev_name in self.devices.items():
            self.log("Système", f"  - {dev_name} ({dev_id})")

    def log(self, source: str, message: str) -> None:
        """Ajoute un message à la file d'attente pour être affiché par le thread principal."""
        timestamp = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
        cleaned_message = strip_ansi(message.rstrip('\n').rstrip('\r'))
        self.log_queue.put((source, timestamp, cleaned_message))

    def process_log_queue(self) -> None:
        """Traite les messages en attente pour mettre à jour l'UI de manière thread-safe."""
        while not self.log_queue.empty():
            try:
                source: str
                timestamp: str
                message: str
                source, timestamp, message = self.log_queue.get_nowait()
                formatted_msg = f"[{timestamp}] {message}\n" if message else "\n"
                combined_msg = f"[{timestamp}] [{source}] {message}\n" if message else "\n"

                # Insertion dans l'onglet approprié
                if source == "Système":
                    self.text_system.insert(tk.END, formatted_msg)
                    self.text_system.see(tk.END)
                elif source in self.device_text_areas:
                    self.device_text_areas[source].insert(tk.END, formatted_msg)
                    self.device_text_areas[source].see(tk.END)

                # Insertion dans l'onglet Combiné avec couleurs
                self.text_combined.insert(tk.END, combined_msg, source)
                self.text_combined.see(tk.END)

            except queue.Empty:
                break

        # Replanifie la fonction dans 100ms
        self.root.after(100, self.process_log_queue)

    def clear_displays(self) -> None:
        self.text_combined.delete('1.0', tk.END)
        self.text_dev1.delete('1.0', tk.END)
        self.text_dev2.delete('1.0', tk.END)
        self.text_system.delete('1.0', tk.END)
        self.log("Système", "Affichages effacés.")

    def stop_all_processes(self) -> None:
        """Interrompt tous les processus en cours (Ctrl-C)."""
        self.log("Système", "⏹️ Interruption de tous les processus...")

        # Interruption des processus courants
        killed_count = 0
        for p in self.current_processes:
            try:
                p.terminate()  # Envoie SIGTERM (equivalent à Ctrl-C)
                killed_count += 1
            except Exception as e:
                self.log("Système", f"Erreur lors de l'arrêt du processus: {str(e)}")

        # Donne 2 secondes aux processus pour se terminer gracieusement
        if killed_count > 0:
            self.root.after(2000, self._force_kill_remaining)

        self.log("Système", f"{killed_count} processus signalés pour interruption.")

    def _force_kill_remaining(self) -> None:
        """Force l'arrêt des processus qui n'ont pas répondu à SIGTERM."""
        for p in self.current_processes:
            try:
                if p.poll() is None:  # Processus encore actif
                    p.kill()
            except Exception:
                pass
        self.current_processes.clear()

    # === COMMANDES SYSTEME (Threads) ===
    def execute_command(self, cmd: str, source_name: str, success_msg: Optional[str] = None, cwd: Optional[str] = None) -> None:
        """Exécute une commande système et redirige la sortie."""
        if cwd is None:
            cwd = PROJECT_DIR

        self.log("Système", f"Exécution : {cmd}")
        try:
            # Préparer l'environnement avec ANDROID_HOME
            env = os.environ.copy()
            if ANDROID_HOME:
                env["ANDROID_HOME"] = ANDROID_HOME

            # shell=True requis pour que Windows trouve "bun" et "adb" correctement
            process = subprocess.Popen(
                cmd,
                cwd=cwd,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace',
                bufsize=1,
                env=env,
            )
            # Track le processus pour pouvoir l'interrompre
            self.current_processes.append(process)

            if process.stdout:
                for line in process.stdout:
                    self.log(source_name, line)

            process.wait()

            # Retire le processus de la liste
            if process in self.current_processes:
                self.current_processes.remove(process)

            if process.returncode == 0 and success_msg:
                self.log("Système", f"Succès : {success_msg}")
            elif process.returncode not in (0, -15, -9):  # -15=SIGTERM, -9=SIGKILL
                self.log("Système", f"ERREUR (Code {process.returncode}) : {cmd}")
        except Exception as e:
            self.log("Système", f"Exception lors de l'exécution: {str(e)}")

    def execute_command_list(self, cmd: list[str], source_name: str, success_msg: Optional[str] = None, cwd: Optional[str] = None) -> None:
        """Exécute une commande via une liste d'args (shell=False) - évite les problèmes de quoting Windows."""
        if cwd is None:
            cwd = PROJECT_DIR

        self.log("Système", f"Exécution : {' '.join(cmd)}")
        try:
            process = subprocess.Popen(
                cmd,
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace',
                bufsize=1,
            )
            self.current_processes.append(process)

            if process.stdout:
                for line in process.stdout:
                    self.log(source_name, line)

            process.wait()

            if process in self.current_processes:
                self.current_processes.remove(process)

            if process.returncode == 0 and success_msg:
                self.log("Système", f"Succès : {success_msg}")
            elif process.returncode not in (0, -15, -9):
                self.log("Système", f"ERREUR (Code {process.returncode}) : {' '.join(cmd)}")
        except Exception as e:
            self.log("Système", f"Exception lors de l'exécution: {str(e)}")

    def run_build(self) -> None:
        self.log("Système", "--- NETTOYAGE DU BUILD ---")

        def build_task() -> None:
            # Nettoie d'abord
            cargo_manifest = os.path.join(PROJECT_DIR, "src-tauri", "Cargo.toml")
            cmd_clean = f"cargo clean --manifest-path {cargo_manifest}"
            self.execute_command(cmd_clean, "Système", None)

            # Puis compile (--target arm64 uniquement : plus rapide + évite les bugs Gradle 9.1 universal)
            self.log("Système", "--- DÉMARRAGE DE LA COMPILATION ---")
            self.execute_command(
                "bun tauri android build --target aarch64 --debug",
                "Système",
                "Compilation terminée avec succès (Mode DEBUG).",
                cwd=PROJECT_DIR
            )
            # Après la compilation, certaines étapes Android essaient de créer
            # des liens symboliques qui échouent sur Windows. Si la librairie
            # native existe mais n'a pas été liée/copied in jniLibs, on la
            # recopie manuellement pour permettre l'assemblage/deploiement.
            try:
                import shutil

                so_src = os.path.join(PROJECT_DIR, "src-tauri", "target", "aarch64-linux-android", "debug", "libmines_app_lib.so")
                so_dst_dir = os.path.join(PROJECT_DIR, "src-tauri", "gen", "android", "app", "src", "main", "jniLibs", "arm64-v8a")
                so_dst = os.path.join(so_dst_dir, "libmines_app_lib.so")

                if os.path.isfile(so_src) and not os.path.isfile(so_dst):
                    os.makedirs(so_dst_dir, exist_ok=True)
                    shutil.copy2(so_src, so_dst)
                    self.log("Système", f"Fallback: copie de la librairie native vers {so_dst}")
                else:
                    if not os.path.isfile(so_src):
                        self.log("Système", "Aucune librairie native .so trouvee (")
                    else:
                        self.log("Système", "La librairie native est deja presente en jniLibs")
            except Exception as e:
                self.log("Système", f"Erreur lors de la copie fallback .so : {e}")

        threading.Thread(target=build_task, daemon=True).start()

    def run_deploy(self, device_id: str, device_name: str) -> None:
        self.log("Système", f"--- DÉPLOIEMENT SUR {device_name} ---")
        def task() -> None:
            # Désinstallation préalable
            self.log("Système", f"Désinstallation de {PACKAGE_NAME}...")
            result = subprocess.run(
                ['adb', '-s', device_id, 'uninstall', PACKAGE_NAME],
                cwd=PROJECT_DIR,
                capture_output=True,
                text=True,
                encoding='utf-8',
            )
            if 'Success' in result.stdout:
                self.log("Système", f"  → {PACKAGE_NAME} désinstallé.")
            else:
                self.log("Système", f"  → Non installé, on continue.")

            # Installation fraîche
            apk_full = os.path.join(PROJECT_DIR, APK_PATH)
            self.execute_command_list(
                ['adb', '-s', device_id, 'install', apk_full],
                "Système", f"APK installé sur {device_name}"
            )

            # Lancement
            self.execute_command_list(
                ['adb', '-s', device_id, 'shell', 'am', 'start', '-n', ACTIVITY_NAME],
                "Système", f"Application lancée sur {device_name}"
            )

            # Démarre automatiquement le logcat pour cet appareil
            self.start_logcat_for_device(device_id, device_name)

        threading.Thread(target=task, daemon=True).start()

    def deploy_all(self) -> None:
        for device_id, device_name in self.devices.items():
            self.run_deploy(device_id, device_name)

    # === LOGCAT ===
    def start_logcat_for_device(self, device_id: str, device_name: str) -> None:
        # 1. Nettoyer les anciens logs
        subprocess.run(['adb', '-s', device_id, 'logcat', '-c'], cwd=PROJECT_DIR)
        self.log("Système", f"Anciens logs effacés pour {device_name}.")

        # 2. Lancer la lecture continue
        # shell=False + liste d'args : évite que cmd.exe sur Windows mange les guillemets
        # des filtres logcat (bug silencieux avec shell=True sur Windows).
        # *:S = silence tout par défaut, puis on sélectionne tag par tag.
        # Tauri/Console:V      → tous les console.log JS (Verbose+)
        # AndroidRuntime:W     → exceptions Java/Kotlin non rattrapées (Warning+)
        # DEBUG:I              → dumps natifs du debuggerd Android (tombstones, Info+)
        # CanariRust:I         → logs Rust via android_logger (Info+)
        # ActivityManager:I    → réception d'Intent par l'OS (deep links)
        # ActivityTaskManager:I→ gestion des tâches et back-stack (deep links)
        cmd = [
            'adb', '-s', device_id, 'logcat',
            '*:S',                      # Silence total par défaut
            'CanariRust:D',             # Moteur OpenMLS (Rust via JNI)
            'CanariFCM:D',              # CanariFirebaseMessagingService (notifications)
            'CanariWorker:D',           # MlsBackgroundWorker (WorkManager)
            'CanariApp:D',              # CanariApplication (init, push secret)
            'fr.emse.canari:D',         # Logs du plugin log de Tauri
            'chromium:I',               # console.log() JS si le plugin Tauri les rate
            'Tauri/Console:V',          # Logs Tauri internes
            'MainActivity:D',           # Sync token FCM au démarrage (addOnSuccessListener)
            'FirebaseMessaging:W',      # SDK FCM Android (erreurs token, connexion)
            'WM-WorkerWrapper:W',       # WorkManager internals (retry/failure)
            'AndroidRuntime:E',         # Crashs (Panic/Exceptions)
            'System.err:W',
        ]
        self.log("Système", f"Démarrage Logcat pour {device_name}: {' '.join(cmd)}")

        process = subprocess.Popen(
            cmd,
            cwd=PROJECT_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1,
        )
        self.logcat_processes.append(process)

        def read_output() -> None:
            if process.stdout:
                for line in process.stdout:
                    parsed = parse_logcat_line(line)
                    if parsed is not None:
                        self.log(device_name, parsed)

        threading.Thread(target=read_output, daemon=True).start()

    def start_all_logcats(self) -> None:
        self.stop_all_logcats()
        for device_id, device_name in self.devices.items():
            self.start_logcat_for_device(device_id, device_name)

    def stop_all_logcats(self) -> None:
        for p in self.logcat_processes:
            p.kill()
        self.logcat_processes.clear()
        self.log("Système", "Tous les processus Logcat ont été arrêtés.")

    def on_closing(self) -> None:
        """Exécuté quand on ferme la fenêtre pour tuer les processus ADB restants."""
        self.stop_all_logcats()
        self.root.destroy()
        sys.exit()

if __name__ == "__main__":
    root = tk.Tk()
    app = TauriManagerApp(root)
    root.mainloop()
