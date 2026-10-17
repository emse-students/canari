# Le Cercle: purging the old history objects on gitlab.emse.fr (2026-10-17)

**Status: DRAFTED, NOT SENT.** Sending it is the user's gesture
([backlog](../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)). The GitLab
instance is the school's: nothing below is done by this project except what a maintainer of the
project may do.

## What happened

The repository `rootz/le-cercle` on `gitlab.emse.fr` carried, in its git history, the legacy
database of the previous version of Le Cercle and the SQL that imported its users: real names, first
names, logins, promotion and balance of about 6 150 people, and about 251 000 transactions since
2013. The project is readable by every account of the school (decision of the user, 2026-10-16), so
that is the audience that could have read it. No evidence of a copy outside the school is known.

On 2026-10-17 the history of `main`, `fix/rgpd` and `chore/canari-emse-fr-rename` was rewritten to
remove these paths in EVERY commit, after a local mirror backup:

- `data/le_cercle.db`
- `dbmigration/legacy-readonly-backup.db`, `dbmigration/02-users.sql`
- `db/legacy_migration/legacy-readonly-backup.db`, `db/legacy_migration/02-users.sql`

The branches no longer contain them (checked on every ref pushed). The originals are kept privately
by the maintainers, outside git.

## What the server still holds, and what is asked

A force-push does not delete the old objects on the server. They stay reachable through references a
maintainer cannot rewrite:

| Where | What is asked |
| --- | --- |
| `refs/merge-requests/*/head` (every merge request opened before the rewrite) | delete these refs, or the merge requests that point at old commits |
| `refs/environments/production/deployments/*` (63 refs, one per deployment) | delete the deployment refs that point at the old commits (the deployments themselves may stay) |
| `refs/keep-around/*` | delete the ones that keep the old commits |
| unreachable objects, once the refs above are gone | run housekeeping with **prune unreachable objects** (project Settings > Repository > Maintenance), or the equivalent on the Gitaly side, then confirm the old blobs are gone |
| pipeline artifacts, caches and job logs that may contain the database | delete the artifacts and caches of the pipelines that ran before 2026-10-17 |
| forks, mirrors and project exports of `rootz/le-cercle` | list them, and tell us whether any exists |
| instance backups and replicas of the GitLab | tell us the retention of backups that contain the old objects |

If a maintainer can do some of this alone (for example the project's own "Remove blobs" tool, with
the object ids we can supply), say so and we will do it; the references of merge requests and
deployments and the instance backups need an administrator.

## What we need back

A written answer stating which of the lines above were done, on which date, and what stays (backup
retention). It is kept in the breach register entry
([breach-procedure](breach-procedure.md#7-the-breach-register-art-335)).

## For the register (Art. 33(5))

Cause: a historical database committed to a repository readable by the whole school. Data: names,
first names, logins, promotion, balances, transactions. Audience: the school's GitLab accounts.
Measures: history rewritten on 2026-10-17, branches checked, server objects purge requested. Risk
assessment (likelihood of harm, notification decision) is the bureau's, with the school's DPO.

## The text to send (French)

> Bonjour,
>
> Le dépôt `rootz/le-cercle` de gitlab.emse.fr contenait dans son historique d'anciennes bases de
> données de l'application (noms, prénoms, identifiants, promotions et soldes d'environ 6 150
> personnes). Nous avons réécrit l'historique des branches `main`, `fix/rgpd` et
> `chore/canari-emse-fr-rename` le 17/10/2026 pour retirer ces fichiers.
>
> Les anciens objets restent accessibles sur le serveur par les références de merge requests
> (`refs/merge-requests/*/head`), de déploiements (`refs/environments/production/deployments/*`) et
> `keep-around`. Pouvez-vous : (1) supprimer ces références, (2) lancer un nettoyage des objets
> inaccessibles (prune), (3) supprimer les artefacts et caches de pipelines antérieurs au
> 17/10/2026, (4) nous dire s'il existe des forks, miroirs ou exports du projet, et (5) nous
> indiquer la durée de conservation des sauvegardes de l'instance qui contiennent les anciens
> objets ? Merci de nous confirmer par écrit ce qui a été fait et à quelle date.
>
> Association Rootz - EMSE, bureau@rootz-emse.fr
