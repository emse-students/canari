# Sauvegarde et restauration Canari

Sauvegarde complete de toutes les donnees persistantes, avec une copie locale
(restauration rapide) et une copie offsite sur le serveur LAN `mitv`
(protection contre la perte du serveur de production).

## Ce qui est sauvegarde

| Source | Methode | Contenu |
| --- | --- | --- |
| PostgreSQL Canari (`auth_db`) | `pg_dump` (dump logique coherent) | users, channels, posts, forms, paiements, **et l historique MLS chiffre** (`queued_message`, `mls_*`) |
| Garage (`infrastructure_garage_data`, `infrastructure_garage_meta`) | **depot restic deduplique uniquement** (voir plus bas) | medias chiffres |
| media-service (`infrastructure_media_meta`) | tar du volume + depot restic | metadonnees media |
| PostgreSQL Authentik (`miconnect`) | `pg_dump` | identites, config OIDC |

Non sauvegarde car transitoire : Kafka, Redis, Zookeeper.

Chaque execution produit une archive unique `canari-backup-AAAAMMJJ-HHMMSS.tar.gz`.

> **MongoDB a ete SUPPRIME de la stack le 2026-08-18**, et son dump avec. L instance ne
> contenait aucune base applicative (verifie le 2026-08-11 puis le 2026-08-18 : seules
> `admin`, `config` et `local` existent) et aucun service ne s y connectait - il n a jamais
> existe de chaine de connexion MongoDB dans le code. Ce tableau annoncait que Mongo portait
> les "blobs MLS chiffres / historique", ce qui etait faux : cet historique est dans
> PostgreSQL. Une archive de 116 octets au manifeste n est pas une panne, mais elle se lit
> comme une sauvegarde, et c est pire. Les archives anterieures au 2026-08-18 portent encore
> le membre `mongo_chat_db.archive.gz` ; `restore.sh` l ignore deliberement.

## Une restauration complete utilise DEUX sources

Depuis la bascule du 2026-08-11, l archive ne contient plus les blobs medias. Il faut
donc l archive (bases + metadonnees) **et** le depot restic (medias). `restore.sh` gere
les deux automatiquement et **s arrete** si les medias sont introuvables, plutot que de
terminer en annoncant une restauration complete qui aurait saute 87 % des donnees.

## Stockage et retention

- Local : `/home/canari/backups`, retention `BACKUP_RETENTION_DAYS` jours (14 par defaut).
- Offsite : `canaribackup@10.0.0.4:/srv/canari-backups` (serveur `mitv`), meme retention.

L acces offsite utilise la cle SSH de `canari` (`~/.ssh/id_ed25519`), autorisee
pour l utilisateur dedie `canaribackup` (membre du groupe `_ssh`) sur `mitv`.

## Installation (serveur de production)

Planification active : **crontab de l utilisateur `canari`** (ne necessite pas
root), declenchee chaque jour a 03:30 :

```cron
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 3 * * * cd /home/canari/canari && ./infrastructure/backup/backup.sh >> /home/canari/backups/backup.log 2>&1
```

Verifier : `crontab -l` et `tail -f /home/canari/backups/backup.log`.

Alternative si un acces root est disponible (timer systemd, fournis dans ce
dossier) :

```bash
sudo cp infrastructure/backup/canari-backup.service /etc/systemd/system/
sudo cp infrastructure/backup/canari-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now canari-backup.timer
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

## Sauvegarde dedupliquee des volumes objets (`backup-objects.sh`)

`backup.sh` re-archivait le volume objet (MinIO, a l epoque) **en entier chaque nuit** et en
gardait 14 : chaque octet vivant coutait donc 15 octets de disque. Les blobs medias sont
chiffres cote client, donc incompressibles et immuables - c est exactement le cas ou une
sauvegarde dedupliquee change tout. Le modele chiffre est dans
[storage-forecast](../../docs/wiki/infrastructure/storage-forecast.md).

`backup-objects.sh` sauvegarde `infrastructure_garage_data`, `infrastructure_garage_meta` et
`infrastructure_media_meta` dans un depot **restic** (image jetable, aucune dependance hote),
applique une retention 14 jours / 8 semaines / 6 mois, verifie l integrite du depot, puis
miroite le depot sur `mitv`. Planifie a **04:00**, apres le tar.

**Le backend objet a migre de MinIO vers Garage le 2026-08-14** (MinIO n est plus maintenu en
amont) - voir [docker](../../docs/wiki/infrastructure/docker.md). Le depot restic continue le
meme historique de sauvegarde ; seuls les chemins montes ont change (`/data/minio` ->
`/data/garage_data` + `/data/garage_meta`). Les instantanes pris avant cette date restent dans
l ancien format - voir le commentaire en tete de `restore.sh`.

Mesures du 2026-08-11 sur la production :

| Mesure | Valeur |
| --- | --- |
| Premier instantane | 44,26 Mio, depot 46 Mo |
| Deuxieme execution (rien n a change) | **24 Ko** ajoutes au depot |
| Restauration de controle | 172 objets medias + metadonnees, **sha256 identique octet pour octet** |

> Les seules differences a la restauration etaient dans `.minio.sys/` (bloom cycle, caches
> d usage, corbeille), que MinIO reecrivait en permanence - mesure valable pour l epoque MinIO
> de ce depot restic. Ce n etaient pas des donnees.

**Bascule prise le 2026-08-11 : ce depot est desormais la SEULE sauvegarde des medias.**
L etape 3 de `backup.sh` (le tar de MinIO) est supprimee, et le membre `minio_data.tar.gz`
a ete retire des 15 archives deja sur disque - sans toucher aux dumps qu elles contiennent,
ce qui est la raison pour laquelle ces archives n ont PAS ete supprimees : elles portent
l unique historique de sauvegarde des bases.

| Mesure | Avant | Apres |
| --- | --- | --- |
| `/home/canari/backups` | 1019 Mo | **133 Mo** (dont 46 Mo de depot restic) |
| Miroir offsite `mitv` | 1019 Mo | **133 Mo** |
| Archive nocturne type | 70-76 Mo | 3-4 Mo |

Le gain immediat en disque est modeste (87 Go etaient libres). Ce que la bascule change est
la **pente** : le cout d une nuit passe du volume entier a ce qui a reellement change.

Le mot de passe du depot vit dans `/home/canari/.config/canari/restic-password` (0600) et
**pas** dans `infrastructure/.env` : la CD regenere ce fichier a chaque deploiement, et un
depot restic dont le mot de passe change est illisible pour toujours. Ce fichier doit etre
copie hors de la machine : sans lui, le depot ET son miroir offsite sont perdus. Si le
fichier est absent, le script s arrete au lieu d en generer un (sinon il creerait
silencieusement un second depot).

Restaurer depuis ce depot :

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -v /home/canari/backups/restic-objects:/repo \
  -v /home/canari/.config/canari/restic-password:/pw:ro \
  -v /tmp/restore:/out \
  -e RESTIC_PASSWORD_FILE=/pw -e RESTIC_REPOSITORY=/repo \
  restic/restic:latest restore latest --target /out
```

## Restauration / migration vers un nouveau serveur

1. Lancer la CD (`main`) : elle genere les `.env`, demarre la stack Canari
   ET la stack Authentik (`miconnect`, cf [../authentik/](../authentik/)).
2. Restaurer la derniere sauvegarde depuis mitv :

```bash
./infrastructure/backup/restore.sh --latest-from-mitv --yes
```

Ou depuis une archive locale precise :

```bash
./infrastructure/backup/restore.sh /home/canari/backups/canari-backup-AAAAMMJJ-HHMMSS.tar.gz --yes
```

> La restauration est **destructive** : elle ecrase les donnees actuelles.
> Elle exige le drapeau `--yes`.
