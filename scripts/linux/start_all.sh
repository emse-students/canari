#!/bin/bash

# Se placer à la racine du projet
cd "$(dirname "$0")/../.." || exit

echo -e "\e[36m===================================================\e[0m"
echo -e "\e[36m    Démarrage de Canari App (Toutes les briques)   \e[0m"
echo -e "\e[36m===================================================\e[0m"

# 1. Démarrer l'infrastructure Docker
echo -e "\n\e[33m[1/4] Démarrage de l'infrastructure Docker...\e[0m"
cd infrastructure/local || exit
docker compose up -d
cd ../..

# 2. Build des librairies partagées
echo -e "\n\e[33m[2/4] Compilation des librairies partagées (shared-ts)...\e[0m"
cd libs/shared-ts || exit
npm install
npm run build
cd ../..

# 3. Lancement des services backend dans des fenêtres séparées (utilisation de gnome-terminal, xterm, ou konsole)
echo -e "\n\e[33m[3/4] Lancement des services backend dans de nouvelles fenêtres...\e[0m"

launch_terminal() {
    local title=$1
    local dir=$2
    local cmd=$3

    if command -v gnome-terminal &> /dev/null; then
        gnome-terminal --title="$title" -- bash -c "cd $dir && $cmd; exec bash"
    elif command -v konsole &> /dev/null; then
        konsole -e bash -c "echo -e '\033]0;$title\007'; cd $dir && $cmd; exec bash" &
    elif command -v xterm &> /dev/null; then
        xterm -T "$title" -e "cd $dir && $cmd; exec bash" &
    else
        echo -e "\e[31mAucun émulateur de terminal compatible trouvé (gnome-terminal, konsole, xterm). Lancement en arrière-plan.\e[0m"
        (cd "$dir" && eval "$cmd") &
    fi
}

launch_terminal "Chat Gateway (Rust)" "apps/chat-gateway" "cargo run"
launch_terminal "Chat Delivery Service (Node)" "apps/chat-delivery-service" "npm install && npm run start:dev"
launch_terminal "Auth Service (Node)" "apps/auth-service" "npm install && npm run start:dev"
launch_terminal "User Service (Node)" "apps/user-service" "npm install && npm run start:dev"
launch_terminal "Channel Service (Node)" "apps/channel-service" "PORT=3005 CHANNELS_MONGO_URI='mongodb://localhost:27017/channel_db' CHANNELS_ENCRYPTION_SECRET='dev-channel-secret-change-me' npm install && npm run start:dev"

# 4. Lancement du frontend (Tauri)
echo -e "\n\e[33m[4/4] Lancement du Frontend (Application Desktop Tauri)...\e[0m"
launch_terminal "Frontend (Tauri)" "frontend" "npm install && npm run tauri dev"

echo -e "\n\e[32m===================================================\e[0m"
echo -e "\e[32m  Tous les services sont en cours de lancement !   \e[0m"
echo -e "\e[32m  Une fenêtre d'application de bureau va s'ouvrir. \e[0m"
echo -e "\e[32m===================================================\e[0m"
