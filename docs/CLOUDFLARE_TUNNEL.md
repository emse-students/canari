# Déploiement avec Cloudflare Tunnel

## Architecture

```
[Client Mobile HTTPS]
        ↓
[Cloudflare Edge (TLS/SSL termination)]
        ↓
[Cloudflare Tunnel - cloudflared]
        ↓
[Nginx local HTTP:8080]
        ↓
[Services Docker]
  ├─ Chat Gateway :3000
  ├─ Chat Delivery :3010
  ├─ Media Service :3011
  ├─ Core Service :3012
  └─ Social Service :3014
  
```

## Avantages de Cloudflare Tunnel

✅ Pas besoin de certificats SSL sur le serveur (Cloudflare gère tout)
✅ Pas besoin d'ouvrir les ports 80/443 publiquement
✅ Protection DDoS automatique
✅ CDN global gratuit
✅ Support WebSocket (wss://)
✅ Configuration simple

## Configuration actuelle

### Cloudflare Tunnel (`~/.cloudflared/config.yml`)

```yaml
tunnel: 7e564786-96b0-4a91-94e6-720032909cfd
credentials-file: /root/.cloudflared/7e564786-96b0-4a91-94e6-720032909cfd.json

ingress:
  - hostname: auth.canari-emse.fr
    service: http://localhost:9000
  - hostname: canari-emse.fr
    service: http://localhost:8080 # ← Nginx écoute ici
  - service: http_status:404
```

### Points clés

1. **Nginx écoute en HTTP** (pas HTTPS) sur le port 8080
2. **Cloudflare gère le TLS** en amont (tunnel sécurisé)
3. Le navigateur voit **HTTPS**, donc `crypto.subtle` fonctionne
4. Les WebSockets utilisent **WSS** automatiquement

## Déploiement

### 1. Vérifier que le tunnel Cloudflare est actif

```bash
# Status du service
sudo systemctl status cloudflared

# Si inactif, démarrer
sudo systemctl start cloudflared

# Activer au démarrage
sudo systemctl enable cloudflared

# Voir les logs
sudo journalctl -u cloudflared -f
```

### 2. Builder et déployer l'application

```bash
# Dans le dossier du projet
cd /root/Canari  # ou votre chemin

# Builder le frontend
cd frontend
bun run build  # ou npm run build

# Retour à la racine
cd ..

# Déployer nginx (port 8080 par défaut pour Cloudflare)
make nginx-install

# Ou avec un port personnalisé
make nginx-install NGINX_PORT=8888
```

### 3. Vérifier le déploiement

```bash
# Nginx écoute bien sur 8080
sudo netstat -tlnp | grep 8080

# Test local
curl http://localhost:8080

# Test via Cloudflare
curl -I https://canari-emse.fr

# Vérifier les services Docker
docker ps
```

## Flux de requête

### Page web

```
Client → https://canari-emse.fr
         ↓
Cloudflare Edge (HTTPS, certificat SSL géré par Cloudflare)
         ↓
Cloudflare Tunnel (connexion chiffrée)
         ↓
Nginx :8080 (HTTP local)
         ↓
Frontend statique (SvelteKit)
```

### WebSocket

```
Client → wss://canari-emse.fr/ws
         ↓
Cloudflare Edge (WSS)
         ↓
Cloudflare Tunnel
         ↓
Nginx :8080 → Chat Gateway :3000
```

### API REST

```
Client → https://canari-emse.fr/mls-api/...
         ↓
Cloudflare Edge
         ↓
Cloudflare Tunnel
         ↓
Nginx :8080 → Chat Delivery :3001
```

## Configuration Nginx

Le fichier [infrastructure/nginx/canari.conf.template](../infrastructure/nginx/canari.conf.template) est optimisé pour Cloudflare :

```nginx
server {
    listen ${NGINX_PORT};  # 8080 par défaut
    server_name ${DOMAIN};

    # Headers indiquant que HTTPS est géré en amont
    location /ws {
        proxy_set_header X-Forwarded-Proto https;
        # ...
    }
}
```

**Note :** Pas de configuration SSL/TLS dans nginx car Cloudflare s'en occupe.

## Troubleshooting

### Le site ne charge pas

```bash
# 1. Vérifier Cloudflare Tunnel
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -n 50

# 2. Vérifier Nginx
sudo systemctl status nginx
sudo nginx -t
sudo tail -f /var/log/nginx/error.log

# 3. Vérifier le port 8080
sudo netstat -tlnp | grep 8080
curl http://localhost:8080
```

### Erreur "crypto.subtle is undefined"

**Causes :**

1. Vous accédez via HTTP au lieu de HTTPS
   - ✅ Solution : Utilisez `https://canari-emse.fr`
2. Cloudflare Tunnel n'est pas actif
   - ✅ Solution : `sudo systemctl restart cloudflared`
3. Configuration DNS incorrecte
   - ✅ Vérifiez le dashboard Cloudflare

### WebSocket ne se connecte pas

```bash
# Vérifier que le Chat Gateway tourne
docker ps | grep gateway
docker logs chat-gateway

# Vérifier que nginx forward correctement
curl -I http://localhost:8080/ws

# Tester la connexion WebSocket
wscat -c wss://canari-emse.fr/ws?token=test
# (installer wscat: npm install -g wscat)
```

### Les services backend ne répondent pas

```bash
# Lister les containers
docker ps

# Démarrer les services
docker compose -f infrastructure/docker-compose.prod.yml up -d

# Voir les logs
docker compose -f infrastructure/docker-compose.prod.yml logs -f

# Vérifier les ports
curl http://localhost:3000  # Gateway
curl http://localhost:3001  # Delivery
```

## Modification de la configuration

### Changer le port nginx

```bash
# Dans le Makefile
make nginx-install NGINX_PORT=9999

# Puis mettre à jour cloudflared config
vim ~/.cloudflared/config.yml
# Changer service: http://localhost:9999
sudo systemctl restart cloudflared
```

### Ajouter un nouveau service

```yaml
# ~/.cloudflared/config.yml
ingress:
  - hostname: auth.canari-emse.fr
    service: http://localhost:9000
  - hostname: api.canari-emse.fr # Nouveau
    service: http://localhost:4000 # Nouveau
  - hostname: canari-emse.fr
    service: http://localhost:8080
  - service: http_status:404
```

```bash
# Redémarrer cloudflared
sudo systemctl restart cloudflared

# Vérifier
curl -I https://api.canari-emse.fr
```

## Monitoring

### Logs en temps réel

```bash
# Cloudflare Tunnel
sudo journalctl -u cloudflared -f

# Nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Services Docker
docker compose -f infrastructure/docker-compose.prod.yml logs -f
```

### Métriques Cloudflare

Dashboard Cloudflare → Zero Trust → Tunnels → Metrics

- Trafic entrant/sortant
- Nombre de connexions
- Latence
- Erreurs

## Sécurité

### Recommendations

1. **Pare-feu** : Bloquez tous les ports sauf SSH

   ```bash
   sudo ufw allow 22/tcp
   sudo ufw enable
   ```

   Les ports 80/443 ne doivent PAS être ouverts (Cloudflare Tunnel gère tout)

2. **Headers de sécurité** : Déjà configurés dans nginx
   - `X-Forwarded-Proto: https`
   - `X-Real-IP`
   - `X-Forwarded-For`

3. **Authentification Cloudflare** : Credentials dans `/root/.cloudflared/`
   ```bash
   sudo chmod 600 /root/.cloudflared/*.json
   ```

## Alternatives

Si vous ne voulez pas utiliser Cloudflare Tunnel, consultez [docs/SSL_SETUP.md](SSL_SETUP.md) pour une configuration avec :

- Let's Encrypt (certificats SSL gratuits)
- Nginx HTTPS direct
- Port 443 ouvert publiquement

## Ressources

- [Cloudflare Tunnel Documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
- [Configuration nginx pour reverse proxy](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/)
- [WebSocket avec Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/configuration/websockets/)
