# The 90-day log ceiling on the shared host - what the DSI is asked to set (2026-10-16)

**Status: DRAFTED, NOT SENT.** Sending it is the user's gesture
([backlog](../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)). Nothing below
was changed by this project: the host is the DSI's, and no install, removal or security setting is
made there without their written agreement, asked BEFORE
([durable-rules](../durable-rules.md), "The shared host").

## Why

Canari's privacy policy (`frontend/src/routes/legal/privacy/+page.svelte`) says, verbatim:

> **Logs techniques** - Adresse IP et horodatage des requêtes HTTP, conservés temporairement à des
> fins de sécurité et de débogage.
>
> **Logs techniques (IP, horodatage)** - Conservés au maximum 90 jours à des fins de sécurité, puis
> supprimés automatiquement.

Every request to `canari.emse.fr` crosses the Portail-etu host's nginx and its CrowdSec stack before
it reaches a Canari container, so the client's address is written in places this repository does
not control. What it DOES control is enforced or reported since 2026-10-16
([logging](logging.md#the-90-day-ceiling-2026-10-16)); this page is the rest.

## What lives where, and who sets it

| Component | What it records that names a person | Owner | Measured | Asked |
| --- | --- | --- | --- | --- |
| systemd-journald | sshd source addresses, sudo, kernel/firewall lines, anything a unit prints | DSI | `/var/log/journal` 357 MB, persistent; limits not readable without root ([storage-and-retention](storage-and-retention.md#logs)) | `MaxRetentionSec` + `MaxFileSec` drop-in, below |
| host nginx (`/var/log/nginx/*.log`, incl. `canari-prod.access.log`, `canari-dev.access.log`, `authentik.access.log`) | client IP, time, URL, user agent of every request | DSI (the vhosts were written by this project before 2026-10-09; changing them now needs the DSI) | 62 MB, rotated by `logrotate` (cron.daily); the `rotate` count was not read | confirm `daily` + `rotate` <= 89, or add `maxage 89` |
| CrowdSec agent and LAPI logs (`/var/log/crowdsec.log`, `crowdsec_api.log`, bouncer log) | banned and inspected client IPs, AppSec matches with the request | DSI | `crowdsec_api.log` 12 MB live + ~1.1 MB gz every ~2 days, **gz files kept since 2026-09-15, no deletion observed** | `common.log_max_age` in `/etc/crowdsec/config.yaml` |
| CrowdSec database (alerts, decisions) | client IPs, with the request that matched | DSI | not read | `db_config.flush.max_age` <= 90 days |
| CrowdSec Central API signal sharing | attacking IPs sent to CrowdSec SAS | DSI | not read | information only: a transfer for the DSI's register, not a retention setting |
| AIDE (`/var/log/aide`) | file integrity reports; no IP expected | DSI | 58 MB, rotation not checked | confirm no IP and a rotation <= 90 days |
| EDR agent | process and, possibly, network telemetry (remote addresses) | DSI / vendor | not visible from the host's side | the console's retention for this host |
| `/var/log/auth.log`, `syslog` (if rsyslog is installed) | sshd source addresses | DSI | not read | confirm the `logrotate` stanza keeps <= 90 days |
| Docker daemon (`/etc/docker/daemon.json` absent) | co-tenant container logs, uncapped (`LogConfig.Config` `{}`) | DSI and each co-tenant | `portail-etu`, `cercle`, `sky` containers have no cap at all | default `log-opts`, below - a SIZE cap, so hygiene, not the 90-day bound |

**Owed by this project, not the DSI** (the user's gestures, listed so nobody asks the DSI for them):

- **Authentik's own event log.** Every `login`, `login_failed` and `authorize_application` event
  stores `client_ip`; the default retention is `days=365`. Admin interface > System > Settings >
  *Event retention*: set `days=90` (or shorter). It is a production write on the identity provider,
  hence the user's. The nightly backup carries `authentik_db.sql.gz` for 14 days, so once the events
  are bounded the archive is too ([backup](backup.md)).
- **Authentik's container logs** (`miconnect` stack, `infrastructure/authentik/compose.yml`):
  capped at 30 MB each, but not bounded in time, for the reason [logging](logging.md#the-90-day-ceiling-2026-10-16)
  gives; the daily report does not read this stack because nothing deploys it. Recreated by hand.
- **The relay VM** (`ssh canari`): its nginx still serves `/api/` on the legacy names and logs
  client addresses; its `logrotate` rotation was never read.

## The settings, exactly

**journald.** A drop-in, so the distribution's file stays untouched:

```ini
# /etc/systemd/journald.conf.d/90-retention.conf
[Journal]
MaxRetentionSec=75day
MaxFileSec=7day
```

then `systemctl restart systemd-journald`. Why not `MaxRetentionSec=90day`: journald deletes whole
journal FILES, and only when it rotates or starts; the active file is never vacuumed. The oldest
entry can therefore be `MaxRetentionSec` plus the span of one file plus the time to the next
rotation - with `MaxFileSec=7day`, at most 75 + 7 + 7 = 89 days. Verify:
`systemd-analyze cat-config systemd/journald.conf | grep -E 'MaxRetentionSec|MaxFileSec'`, then
`journalctl -o short-iso | head -n 1` - the oldest entry, which must be under 90 days old (it will
drop after the first weekly rotation, not immediately).

**nginx (logrotate).** In `/etc/logrotate.d/nginx`, the stanza covering `/var/log/nginx/*.log`
keeps `daily` and a `rotate` of at most 89, and gains `maxage 89` so a file rotated earlier is
removed even if the count would keep it. Verify: `logrotate -d /etc/logrotate.d/nginx` (dry run),
then `ls -l --time-style=+%F /var/log/nginx/ | sort -k6 | head -n 3`.

**CrowdSec logs.** In `/etc/crowdsec/config.yaml`, `common:` section:

```yaml
common:
  log_media: file
  log_max_age: 80   # days; rotated files older than this are deleted
```

CrowdSec rotates through lumberjack, which dates a rotated file by its ROTATION time, and a file
spans the days since the previous rotation (~2 days measured), so 80 leaves the slack. The same key
exists in the bouncer's own configuration if it logs to a file. Verify: `systemctl restart crowdsec`,
then `ls -l --time-style=+%F /var/log/ | grep -i crowdsec`; nothing older than 90 days.

**CrowdSec database.**

```yaml
db_config:
  flush:
    max_age: 7d     # the package default; anything <= 90d keeps the promise
    max_items: 5000
```

Verify: `cscli alerts list --until 2160h` lists nothing (2160 h = 90 days).

**AIDE.** Confirm the reports carry no client address, and that `/var/log/aide` is rotated with a
retention of at most 90 days (`logrotate -d` on the stanza that covers it).

**EDR.** The retention configured in the vendor console for this host's telemetry, and whether
network connections (remote addresses) are collected. If the DSI's own security processing needs
longer, that is the DSI's legal basis, not Canari's promise - but Canari's policy then has to say so,
which is why the answer is asked rather than assumed.

**Docker daemon defaults (co-tenants).** `/etc/docker/daemon.json`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
```

It applies only to containers created after the daemon restart, it bounds SIZE and not age, and a
daemon restart restarts every container on the host - so it is a request for a maintenance window,
not a gesture. Canari's and Authentik's services already carry this per service.

## The request, ready to send (French)

> Objet : Durees de conservation des journaux sur le serveur Portail-etu (demande, aucune action de
> notre part)
>
> Bonjour,
>
> La politique de confidentialite de Canari (https://canari.emse.fr/legal/privacy) promet que les
> journaux techniques contenant une adresse IP sont conserves 90 jours au maximum puis supprimes
> automatiquement. Une partie de ces journaux est ecrite sur le serveur Portail-etu par des
> composants que vous administrez ; nous n'avons rien modifie et ne modifierons rien sans votre
> accord. De notre cote, les journaux des conteneurs Canari et leurs archives sont desormais bornes
> ou surveilles (rapport quotidien).
>
> Pourriez-vous, si cela vous convient :
>
> 1. **journald** : ajouter `/etc/systemd/journald.conf.d/90-retention.conf` avec
>    `[Journal]`, `MaxRetentionSec=75day`, `MaxFileSec=7day`, puis redemarrer
>    `systemd-journald` (75 + 2 x 7 jours reste sous 90, journald ne supprimant que des fichiers
>    entiers lors d'une rotation).
> 2. **nginx** : confirmer que `/etc/logrotate.d/nginx` (qui couvre `canari-prod.access.log`,
>    `canari-dev.access.log` et `authentik.access.log`) est en `daily` avec `rotate` <= 89, et y
>    ajouter `maxage 89`.
> 3. **CrowdSec** : regler `common.log_max_age: 80` dans `/etc/crowdsec/config.yaml` (les archives
>    `crowdsec_api.log` s'accumulent depuis le 15/09 sans suppression), et confirmer
>    `db_config.flush.max_age` <= 90 jours (7 jours par defaut). Nous notons aussi, pour votre
>    registre, que le partage de signaux vers l'API centrale CrowdSec transmet des adresses IP a un
>    tiers.
> 4. **AIDE** : confirmer que les rapports de `/var/log/aide` ne contiennent pas d'adresse IP et
>    sont conserves 90 jours au maximum.
> 5. **EDR** : nous indiquer la duree de conservation de la telemetrie de ce serveur (et si les
>    connexions reseau, donc des adresses IP distantes, sont collectees).
> 6. **auth.log / syslog** (si rsyslog est present) : confirmer une rotation <= 90 jours.
> 7. **Docker** (facultatif, hors promesse) : envisager, lors d'une fenetre de maintenance, des
>    `log-opts` par defaut (`max-size` 10m, `max-file` 3) dans `/etc/docker/daemon.json` pour les
>    conteneurs des autres associations, qui n'ont aujourd'hui aucun plafond.
>
> Pour verifier : `journalctl -o short-iso | head -n 1`, `ls -l --time-style=+%F /var/log/nginx/`,
> `cscli alerts list --until 2160h` ; aucune entree ne doit avoir plus de 90 jours.
>
> Si l'un de ces journaux doit etre conserve plus longtemps pour vos propres besoins de securite,
> dites-le-nous : nous ajusterons la politique de confidentialite pour l'indiquer plutot que de
> promettre une duree que nous ne tenons pas.
>
> Merci,

## When it is done

Each row above is closed by the DSI's answer AND one read-only reading of the verification command
on the host (`ssh portail-etu-direct`, free, no setting changed). Record the answer and the reading
in [storage-and-retention](storage-and-retention.md#logs), delete the backlog line, and delete this
page once every row is closed.
