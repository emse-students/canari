### Changed - le deploiement de production passe enfin par les scripts que dev exerce depuis trois semaines

`serve-prod.yml` tombe de 943 a 306 lignes : 277 lignes de `if [ -n "$X" ]; then upsert; else warn`
ecrites a la main, plus ses propres copies du pull, du up, des migrations et de l attente de sante,
remplacees par `render-env.sh` et `deploy-environment.sh`. L equivalence est MESUREE et non supposee :
le rendu reproduit les 61 cles du `.env` de prod sans une seule valeur differente. Un troisieme
script, `verify-secrets.sh`, verifie ensuite que les CONTENEURS portent ce qui a ete rendu - derive
du compose, 51 paires la ou la version ecrite a la main en couvrait 5.
[cicd](docs/wiki/cicd.md).
