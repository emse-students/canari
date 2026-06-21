# Sauvegarde et restauration Canari

Sauvegarde complete de toutes les donnees persistantes, avec une copie locale
(restauration rapide) et une copie offsite sur le serveur LAN `mitv`
(protection contre la perte du serveur de production).

## Ce qui est sauvegarde

| Source | Methode | Contenu |
| --- | --- | --- |
| PostgreSQL Canari (`auth_db`) | `pg_dump` (dump logique coherent) | users, channels, posts, forms, paiements |
| MongoDB (`chat_db`) | `mongodump` | blobs MLS chiffres / historique |
| MinIO (`infrastructure_minio_data`) | tar du volume | medias chiffres |
| media-service (`infrastructure_media_meta`) | tar du volume | metadonnees media |
| PostgreSQL Authentik (`miconnect`) | `pg_dump` | identites, config OIDC |

Non sauvegarde car transitoire : Kafka, Redis, Zookeeper.

Chaque execution produit une archive unique `canari-backup-AAAAMMJJ-HHMMSS.tar.gz`.

## Stockage et retention

- Local : `/home/canari/backups`, retention `BACKUP_RETENTION_DAYS` jours (14 par defaut).
- Offsite : `canaribackup@10.0.0.4:/srv/canari-backups` (serveur `mitv`), meme retention.

L acces offsite utilise la cle SSH de `canari` (`~/.ssh/id_ed25519`), autorisee
pour l utilisateur dedie `canaribackup` (membre du groupe `_ssh`) sur `mitv`.

## Installation (serveur de production)

```bash
# Depuis /home/canari/canari
sudo cp infrastructure/backup/canari-backup.service /etc/systemd/system/
sudo cp infrastructure/backup/canari-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now canari-backup.timer

# Verifier la planification
systemctl list-timers canari-backup.timer
```

Lancer une sauvegarde immediate :

```bash
sudo systemctl start canari-backup.service
journalctl -u canari-backup.service -f
# ou directement :
./infrastructure/backup/backup.sh
```

## Configuration (optionnelle, via `infrastructure/.env`)

| Variable | Defaut | Role |
| --- | --- | --- |
| `BACKUP_DIR` | `/home/canari/backups` | dossier local des archives |
| `BACKUP_RETENTION_DAYS` | `14` | retention locale et offsite |
| `BACKUP_SSH_HOST` | `canaribackup@10.0.0.4` | cible offsite (vide = desactive) |
| `BACKUP_SSH_PATH` | `/srv/canari-backups` | dossier offsite sur mitv |
| `MICONNECT_PG_CONTAINER` | `miconnect-postgresql-1` | conteneur PG Authentik (vide = exclu) |

## Restauration / migration vers un nouveau serveur

1. Cloner le depot, generer `infrastructure/.env` (ou laisser la CD le faire).
2. Demarrer la stack : `docker compose -f infrastructure/docker-compose.prod.yml up -d`.
3. Demarrer la stack Authentik (`miconnect`) si elle est incluse.
4. Restaurer la derniere sauvegarde depuis mitv :

```bash
./infrastructure/backup/restore.sh --latest-from-mitv --yes
```

Ou depuis une archive locale precise :

```bash
./infrastructure/backup/restore.sh /home/canari/backups/canari-backup-AAAAMMJJ-HHMMSS.tar.gz --yes
```

> La restauration est **destructive** : elle ecrase les donnees actuelles.
> Elle exige le drapeau `--yes`.
