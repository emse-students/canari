import tkinter as tk
from tkinter import ttk, scrolledtext
import subprocess
import threading
import queue
import datetime
import sys
import re
from typing import Optional

# === CONFIGURATION ===
PROJECT_DIR = r"D:\Documents\Programmation\EMSE\Canari\frontend"
APK_PATH = r"src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk"
PACKAGE_NAME = "fr.emse.canari"
ACTIVITY_NAME = f"{PACKAGE_NAME}/.MainActivity"

DEV1_ID = "2A251JEGR05373"
DEV2_ID = "fa71073b"
DEV1_NAME = "Pixel 6a"
DEV2_NAME = "Mi 9T"

def strip_ansi(text: str) -> str:
    """Supprime les codes d'échappement ANSI de la chaîne."""
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    return ansi_escape.sub('', text)

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

        self.setup_ui()
        self.root.after(100, self.process_log_queue)

    def setup_ui(self) -> None:
        # --- Cadre des Contrôles ---
        control_frame = ttk.LabelFrame(self.root, text="Actions", padding=(10, 5))
        control_frame.pack(fill=tk.X, padx=10, pady=5)

        ttk.Button(control_frame, text="1. Compiler (Bun)", command=self.run_build).pack(side=tk.LEFT, padx=5)
        ttk.Button(control_frame, text=f"2. Installer & Lancer ({DEV1_NAME})", command=lambda: self.run_deploy(DEV1_ID, DEV1_NAME)).pack(side=tk.LEFT, padx=5)
        ttk.Button(control_frame, text=f"2. Installer & Lancer ({DEV2_NAME})", command=lambda: self.run_deploy(DEV2_ID, DEV2_NAME)).pack(side=tk.LEFT, padx=5)
        ttk.Button(control_frame, text="Tout Installer & Lancer", command=self.deploy_both).pack(side=tk.LEFT, padx=5)

        ttk.Separator(control_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=10)

        ttk.Button(control_frame, text="Lancer Logcat", command=self.start_all_logcats).pack(side=tk.LEFT, padx=5)
        ttk.Button(control_frame, text="Arrêter Logcat", command=self.stop_all_logcats).pack(side=tk.LEFT, padx=5)

        ttk.Separator(control_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=10)

        # Bouton Stop avec style rouge
        stop_button = ttk.Button(control_frame, text="⏹️ STOP", command=self.stop_all_processes)
        stop_button.pack(side=tk.LEFT, padx=5)

        ttk.Button(control_frame, text="Effacer les affichages", command=self.clear_displays).pack(side=tk.RIGHT, padx=5)

        # --- Cadre des Logs (Onglets) ---
        notebook = ttk.Notebook(self.root)
        notebook.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        # Onglet de suivi temps réel (côte à côte)
        monitoring_frame = ttk.Frame(notebook)
        notebook.add(monitoring_frame, text="📱 Suivi Temps Réel")

        # PanedWindow pour diviser en deux colonnes
        paned: ttk.PanedWindow = ttk.PanedWindow(monitoring_frame, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        # Colonne gauche (Appareil 1)
        left_frame: ttk.LabelFrame = ttk.LabelFrame(paned, text=f"🔴 {DEV1_NAME}", padding=5)
        paned.add(left_frame)  # type: ignore
        self.text_dev1: scrolledtext.ScrolledText = scrolledtext.ScrolledText(left_frame, wrap=tk.WORD, bg="#1e1e1e", fg="#569cd6", font=("Consolas", 9))
        self.text_dev1.pack(fill=tk.BOTH, expand=True)

        # Colonne droite (Appareil 2)
        right_frame: ttk.LabelFrame = ttk.LabelFrame(paned, text=f"🟢 {DEV2_NAME}", padding=5)
        paned.add(right_frame)  # type: ignore
        self.text_dev2: scrolledtext.ScrolledText = scrolledtext.ScrolledText(right_frame, wrap=tk.WORD, bg="#1e1e1e", fg="#4ec9b0", font=("Consolas", 9))
        self.text_dev2.pack(fill=tk.BOTH, expand=True)

        # Autres onglets
        self.text_combined: scrolledtext.ScrolledText = scrolledtext.ScrolledText(notebook, wrap=tk.WORD, bg="#1e1e1e", fg="#d4d4d4", font=("Consolas", 10))
        self.text_system: scrolledtext.ScrolledText = scrolledtext.ScrolledText(notebook, wrap=tk.WORD, bg="#1e1e1e", fg="#ce9178", font=("Consolas", 10))

        notebook.add(self.text_combined, text="📋 Logs Combinés")
        notebook.add(self.text_system, text="⚙️ Système (Compilation/Infos)")

        # Configuration des tags de couleurs pour le log combiné
        self.text_combined.tag_config(DEV1_NAME, foreground="#569cd6")
        self.text_combined.tag_config(DEV2_NAME, foreground="#4ec9b0")
        self.text_combined.tag_config("Système", foreground="#ce9178")

    # === LOGIQUE D'AFFICHAGE ===
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

                # Insertion dans l'onglet Système ou Appareil spécifique
                if source == "Système":
                    self.text_system.insert(tk.END, formatted_msg)
                    self.text_system.see(tk.END)
                elif source == DEV1_NAME:
                    self.text_dev1.insert(tk.END, formatted_msg)
                    self.text_dev1.see(tk.END)
                elif source == DEV2_NAME:
                    self.text_dev2.insert(tk.END, formatted_msg)
                    self.text_dev2.see(tk.END)

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
    def execute_command(self, cmd: str, source_name: str, success_msg: Optional[str] = None) -> None:
        """Exécute une commande système et redirige la sortie."""
        self.log("Système", f"Exécution : {cmd}")
        try:
            # shell=True requis pour que Windows trouve "bun" et "adb" correctement
            process = subprocess.Popen(
                cmd,
                cwd=PROJECT_DIR,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace',
                bufsize=1,
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

    def run_build(self) -> None:
        self.log("Système", "--- NETTOYAGE DU BUILD ---")

        def build_task() -> None:
            # Nettoie d'abord
            cmd_clean = "cargo clean --manifest-path src-tauri/Cargo.toml"
            self.execute_command(cmd_clean, "Système", None)

            # Puis compile (--target arm64 uniquement : plus rapide + évite les bugs Gradle 9.1 universal)
            self.log("Système", "--- DÉMARRAGE DE LA COMPILATION ---")
            self.execute_command(
                "bun tauri android build --debug --target aarch64",
                "Système",
                "Compilation terminée avec succès."
            )

        threading.Thread(target=build_task, daemon=True).start()

    def run_deploy(self, device_id: str, device_name: str) -> None:
        self.log("Système", f"--- DÉPLOIEMENT SUR {device_name} ---")
        def task() -> None:
            # Installation
            cmd_install = f'adb -s {device_id} install -r "{APK_PATH}"'
            self.execute_command(cmd_install, "Système", f"APK installé sur {device_name}")

            # Lancement
            cmd_launch = f'adb -s {device_id} shell am start -n {ACTIVITY_NAME}'
            self.execute_command(cmd_launch, "Système", f"Application lancée sur {device_name}")

            # Démarre automatiquement le logcat pour cet appareil (nettoie l'ancien avant)
            self.start_logcat_for_device(device_id, device_name)

        threading.Thread(target=task, daemon=True).start()

    def deploy_both(self) -> None:
        self.run_deploy(DEV1_ID, DEV1_NAME)
        self.run_deploy(DEV2_ID, DEV2_NAME)

    # === LOGCAT ===
    def start_logcat_for_device(self, device_id: str, device_name: str) -> None:
        # 1. Nettoyer les anciens logs
        subprocess.run(f'adb -s {device_id} logcat -c', shell=True, cwd=PROJECT_DIR)
        self.log("Système", f"Anciens logs effacés pour {device_name}.")

        # 2. Lancer la lecture continue
        cmd = f'adb -s {device_id} logcat -s "Tauri/Console"'
        self.log("Système", f"Démarrage Logcat pour {device_name}...")

        process = subprocess.Popen(
            cmd,
            cwd=PROJECT_DIR,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1 # Line buffered
        )
        self.logcat_processes.append(process)

        def read_output() -> None:
            if process.stdout:
                for line in process.stdout:
                    self.log(device_name, line)

        threading.Thread(target=read_output, daemon=True).start()

    def start_all_logcats(self) -> None:
        self.stop_all_logcats()
        self.start_logcat_for_device(DEV1_ID, DEV1_NAME)
        self.start_logcat_for_device(DEV2_ID, DEV2_NAME)

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
