### Fixed - deux fichiers supprimes par accident sont revenus, et le gate qui aurait du le dire
ne regardait que le quart des liens

`wiki-links.test.mjs` promettait *every intra-repository markdown link resolves* et ne filtrait que
`*.md#ancre` : un lien vers un script ou vers une page sans ancre n'etait jamais lu. Elargi, il
trouve DIX liens morts sur 2150 - dont un runbook de production de 380 lignes et une archive de
campagne de 512 lignes, supprimes en dommage collateral dans des PR sans rapport et toujours cites
comme vivants par cinq pages. Les deux sont restaures. Au passage, dix-sept references au present a
des mecanismes supprimes le 2026-09-04 (`dependabot-auto-merge.yml`, `auto-merge.yml`, le balayage
horaire) sont corrigees, et deux entrees du backlog qui etaient fausses le jour ou elles ont ete
ecrites sont supprimees.
[durable-rules](docs/wiki/durable-rules.md), [cicd](docs/wiki/cicd.md)
