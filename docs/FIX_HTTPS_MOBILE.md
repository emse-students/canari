# Correctif : Support HTTPS avec Cloudflare Tunnel

## Problème

L'application Canari rencontrait l'erreur suivante sur mobile :

```
Gateway inaccessible: can't access property "importKey", crypto.subtle is undefined
```

### Cause

L'API Web Crypto (`crypto.subtle`) utilisée pour la cryptographie n'est disponible que dans des **contextes sécurisés** :

- ✅ HTTPS
- ✅ localhost (développement uniquement)
- ❌ HTTP (non sécurisé)

## Architecture avec Cloudflare Tunnel

L'application utilise **Cloudflare Tunnel** pour gérer le TLS/HTTPS :

```
[Client Mobile HTTPS]
        ↓
[Cloudflare Edge (TLS termination)]
        ↓
[Cloudflare Tunnel]
        ↓
[Serveur local - Nginx HTTP:8080]
        ↓
[Services backend]
```

### Avantages

- ✅ Pas besoin de certificats SSL sur le serveur
- ✅ Pas besoin d'ouvrir les ports 80/443
- ✅ Protection DDoS Cloudflare
- ✅ CDN global automatique
- ✅ Renouvellement automatique des certificats

## Configuration actuelle

### Cloudflare Tunnel (`~/.cloudflared/config.yml`)

```yaml
tunnel: 7e564786-96b0-4a91-94e6-720032909cfd
credentials-file: /root/.cloudflared/7e564786-96b0-4a91-94e6-720032909cfd.json

ingress:
  - hostname: auth.canari-emse.fr
    service: http://localhost:9000
  - hostname: canari-emse.fr
    service: http://localhost:8080 # Nginx écoute ici
  - service: http_status:404
```

### Nginx

Nginx écoute en **HTTP sur le port 8080** (pas HTTPS) car :

- Cloudflare gère déjà le TLS
- Le tunnel Cloudflare se connecte en HTTP local
- Les headers `X-Forwarded-Proto: https` indiquent au backend que la requête originale était HTTPS

## Solution implémentée

### 1. Configuration nginx adaptée pour Cloudflare Tunnel

Nginx écoute maintenant en HTTP sur le port configurable (8080 par défaut) :

```nginx
server {
    listen 8080;  # Port configuré dans Cloudflare Tunnel
    server_name canari-emse.fr;

    # Headers pour indiquer que HTTPS est géré en amont
    proxy_set_header X-Forwarded-Proto https;
    # ... reste de la config
}
```

### 2. Makefile adapté

```makefile
NGINX_PORT ?= 8080  # Port pour Cloudflare Tunnel

nginx-install:
    # Déploie nginx sans configuration SSL
    # Cloudflare gère le TLS en amont
```

### 3. WebSocket sécurisé

La connexion WebSocket utilise automatiquement WSS quand le site est accédé via HTTPS :

```typescript
// Conversion automatique https:// -> wss://
const wsUrl = this.baseUrl.replace(/^https?:/, (match) => (match === 'https:' ? 'wss:' : 'ws:'));
```

### 4. Vérification crypto.subtle avec message adapté

## Déploiement avec Cloudflare Tunnel

### Configuration Cloudflare Tunnel (déjà en place)

Le tunnel est déjà configuré et actif :

```bash
# Vérifier que le tunnel est actif
sudo systemctl status cloudflared

# Voir les logs
sudo journalctl -u cloudflared -f
```

### Déploiement de l'application

```bash
# 1. Builder le frontend
cd frontend
bun run build

# 2. Déployer nginx (écoute sur port 8080 par défaut)
cd ..
make nginx-install

# 3. Vérifier que nginx écoute bien sur 8080
sudo netstat -tlnp | grep 8080

# 4. Tester en local
curl http://localhost:8080

# 5. Tester via Cloudflare
curl -I https://canari-emse.fr
```

### Personnaliser le port nginx

Si votre tunnel Cloudflare utilise un port différent :

````bash
# Modifier le port dans le Makefile ou en ligne de commande
make nginx-install NGINX_PORT=8888
### Option 1 : Déploiement avec HTTPS

Accédez simplement à `https://votre-domaine.com` depuis votre mobile.

### Option 2 : Tunnel HTTPS pour développement

```bash
# Avec ngrok
ngrok http 80

# Accédez à l'URL HTTPS fournie (ex: https://abc123.ngrok.io)
````

## Documentation complète

Voir [docs/SSL_SETUP.md](docs/SSL_SETUP.md) pour :

- Guide complet de configuration SSL
- Renouvellement automatique des certificats
- Troubleshooting
- Meilleures pratiques de sécurité

## Documentation complète

### Architecture Cloudflare Tunnel

Cloudflare Tunnel crée un tunnel sécurisé entre votre serveur et Cloudflare Edge, éliminant le besoin de :

- Ouvrir les ports 80/443 publiquement
- Gérer des certificats SSL localement
- Configurer un pare-feu complexe

### Flux de requête

1. Client mobile → `https://canari-emse.fr`
2. DNS Cloudflare → Cloudflare Edge (TLS terminé ici)
3. Cloudflare Tunnel → `http://localhost:8080` (nginx)
4. Nginx → Services backend (Gateway:3000, Delivery:3001)

### Pour configuration Let's Encrypt standard

Si vous n'utilisez pas Cloudflare Tunnel, consultez [docs/SSL_SETUP.md](docs/SSL_SETUP.md) pour une configuration avec certificats SSL locaux.SETUP.md) - Documentation SSL complète

## Notes importantes

⚠️ **L'application ne fonctionnera PAS sur mobile sans HTTPS**

L'API Web Crypto est une exigence de sécurité du navigateur, pas une limitation de l'application. HTTPS est obligatoire pour :

- Utilisation de `crypto.subtle`
- Protection des données en transit
- Conformité aux standards de sécurité web modernes

## Vérification du bon fonctionnement

Après avoir activé HTTPS, vous devriez voir dans les logs :

```
[12:52:27] Initialisé en mode WEB (WASM)
[12:52:33] Initialisation MLS...
[12:52:33] État chargé depuis le stockage local.
[12:52:33] [RUST::INFO] WasmMlsClient::new called for user: jolan2
[12:52:33] Identité MLS initialisée (device: web-jolan2-mmhmdh0i-vzg8)
[12:52:33] Connexion Gateway...
[12:52:33] Connecting to WebSocket: wss://votre-domaine.com/ws?token=***
[12:52:33] Connected to Chat Gateway with DeviceID: web-jolan2-mmhmdh0i-vzg8
[12:52:34] KeyPackage publié.
```

Au lieu de l'erreur `crypto.subtle is undefined`.
