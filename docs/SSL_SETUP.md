# Configuration SSL/HTTPS pour Canari

## Pourquoi HTTPS est nécessaire

L'application Canari nécessite HTTPS pour fonctionner correctement sur mobile car elle utilise l'API Web Crypto (`crypto.subtle`) pour la cryptographie. Cette API n'est disponible que dans des contextes sécurisés :

- HTTPS
- localhost (développement uniquement)

Sans HTTPS, vous verrez l'erreur : `crypto.subtle is undefined`

## Options de configuration SSL

### Option 1 : Let's Encrypt (Recommandé pour la production)

Let's Encrypt fournit des certificats SSL gratuits et automatiquement renouvelables.

#### Installation de Certbot

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install certbot python3-certbot-nginx

# CentOS/RHEL
sudo yum install certbot python3-certbot-nginx
```

#### Obtenir un certificat

```bash
# Arrêter nginx temporairement
sudo systemctl stop nginx

# Obtenir le certificat
sudo certbot certonly --standalone -d votre-domaine.com

# Les certificats seront dans :
# /etc/letsencrypt/live/votre-domaine.com/fullchain.pem
# /etc/letsencrypt/live/votre-domaine.com/privkey.pem
```

#### Configuration des variables d'environnement

Ajoutez à votre fichier `.env` ou au script de déploiement :

```bash
export SSL_CERTIFICATE_PATH=/etc/letsencrypt/live/votre-domaine.com/fullchain.pem
export SSL_CERTIFICATE_KEY_PATH=/etc/letsencrypt/live/votre-domaine.com/privkey.pem
```

#### Renouvellement automatique

```bash
# Tester le renouvellement
sudo certbot renew --dry-run

# Ajouter un cron job pour le renouvellement automatique
sudo crontab -e

# Ajouter cette ligne pour vérifier le renouvellement quotidiennement à 2h du matin
0 2 * * * certbot renew --quiet --post-hook "systemctl reload nginx"
```

### Option 2 : Certificat auto-signé (Développement/Test uniquement)

⚠️ Les certificats auto-signés génèrent des avertissements de sécurité dans les navigateurs. À utiliser uniquement pour le développement.

```bash
# Créer le répertoire pour les certificats
sudo mkdir -p /etc/nginx/ssl

# Générer le certificat auto-signé
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/canari.key \
  -out /etc/nginx/ssl/canari.crt \
  -subj "/C=FR/ST=Loire/L=Saint-Etienne/O=EMSE/CN=localhost"

# Configuration des variables
export SSL_CERTIFICATE_PATH=/etc/nginx/ssl/canari.crt
export SSL_CERTIFICATE_KEY_PATH=/etc/nginx/ssl/canari.key
```

### Option 3 : Certificat d'une autorité commerciale

Si vous avez acheté un certificat SSL d'une autorité de certification :

1. Placez les fichiers de certificat sur le serveur
2. Configurez les chemins :

```bash
export SSL_CERTIFICATE_PATH=/chemin/vers/certificat.crt
export SSL_CERTIFICATE_KEY_PATH=/chemin/vers/cle-privee.key
```

## Déploiement avec HTTPS

### 1. Mettre à jour le script de déploiement

Dans `scripts/deploy.sh` ou votre script de déploiement, assurez-vous que les variables SSL sont définies :

```bash
# Vérifier que les certificats SSL sont configurés
if [ -z "$SSL_CERTIFICATE_PATH" ] || [ -z "$SSL_CERTIFICATE_KEY_PATH" ]; then
  echo "⚠️  Variables SSL non définies. HTTPS requis pour mobile."
  echo "Définissez SSL_CERTIFICATE_PATH et SSL_CERTIFICATE_KEY_PATH"
  exit 1
fi
```

### 2. Générer la configuration nginx

```bash
# Les variables doivent être définies avant d'exécuter make
export DOMAIN=votre-domaine.com
export SSL_CERTIFICATE_PATH=/etc/letsencrypt/live/votre-domaine.com/fullchain.pem
export SSL_CERTIFICATE_KEY_PATH=/etc/letsencrypt/live/votre-domaine.com/privkey.pem
export FRONTEND_BUILD_PATH=/chemin/vers/frontend/build
export GATEWAY_PORT=3000
export DELIVERY_PORT=3001

make nginx-install
```

### 3. Tester la configuration

```bash
# Vérifier la configuration nginx
sudo nginx -t

# Recharger nginx
sudo systemctl reload nginx
```

### 4. Vérifier HTTPS

```bash
# Tester avec curl
curl -I https://votre-domaine.com

# Vérifier le certificat
openssl s_client -connect votre-domaine.com:443 -servername votre-domaine.com
```

## Configuration WebSocket avec HTTPS

Lorsque vous utilisez HTTPS, les WebSockets doivent également utiliser WSS (WebSocket Secure).

### Mise à jour frontend

Dans votre configuration frontend, assurez-vous d'utiliser le bon protocole :

```javascript
// Détection automatique du protocole
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
```

## Test sur mobile

### Option 1 : Utiliser un tunnel pour le développement

Pour tester sur mobile sans déployer, vous pouvez utiliser un service de tunnel HTTPS :

#### ngrok

```bash
# Installer ngrok
npm install -g ngrok

# Exposer votre serveur local
ngrok http 80

# ngrok vous donnera une URL HTTPS comme : https://abc123.ngrok.io
```

#### Cloudflare Tunnel

```bash
# Installer cloudflared
# Voir : https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/

cloudflared tunnel --url http://localhost:80
```

### Option 2 : Configuration du réseau local avec certificat auto-signé

1. Générez un certificat pour votre IP locale
2. Installez le certificat sur votre appareil mobile
3. Accédez à `https://192.168.x.x` depuis votre mobile

## Troubleshooting

### Erreur : "crypto.subtle is undefined"

- ✅ Vérifiez que vous accédez via HTTPS (pas HTTP)
- ✅ Vérifiez que le certificat SSL est valide
- ✅ Sur mobile, vérifiez que le certificat est approuvé

### Erreur : "NET::ERR_CERT_AUTHORITY_INVALID"

- Pour développement : acceptez l'exception de sécurité
- Pour production : utilisez Let's Encrypt ou un certificat valide

### WebSocket ne se connecte pas

- Vérifiez que vous utilisez `wss://` et non `ws://`
- Vérifiez les headers proxy dans nginx (`X-Forwarded-Proto`)

### Port 443 déjà utilisé

```bash
# Voir quel processus utilise le port
sudo lsof -i :443

# Arrêter le processus si nécessaire
sudo systemctl stop <service-name>
```

## Références

- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [MDN: Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [nginx SSL Configuration](https://nginx.org/en/docs/http/configuring_https_servers.html)
- [SSL Labs Server Test](https://www.ssllabs.com/ssltest/) - Testez votre configuration SSL
