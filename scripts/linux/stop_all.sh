#!/bin/bash

# Se placer à la racine du projet
cd "$(dirname "$0")/../.." || exit

echo -e "\e[36m===================================================\e[0m"
echo -e "\e[36m    Arrêt de Canari App (Toutes les briques)       \e[0m"
echo -e "\e[36m===================================================\e[0m"

echo -e "\n\e[33m[1/2] Arrêt de l'infrastructure Docker...\e[0m"
cd infrastructure/local || exit
docker compose down
cd ../..

echo -e "\n\e[33m[2/2] Fermeture des processus de la suite Canari...\e[0m"

# Tuer les processus backend connus
pkill -f "cargo run"
pkill -f "chat-delivery-service"
pkill -f "auth-service"
pkill -f "user-service"

# Tuer le frontend (Vite & Tauri)
pkill -f "tauri dev"
pkill -f "vite dev"
pkill -f "mines-app"

echo -e "\n\e[32m===================================================\e[0m"
echo -e "\e[32m  Tous les services ont été arrêtés !              \e[0m"
echo -e "\e[32m===================================================\e[0m"
