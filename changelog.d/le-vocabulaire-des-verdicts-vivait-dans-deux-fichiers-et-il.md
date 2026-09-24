### Fixed - le vocabulaire des verdicts vivait dans deux fichiers, et il a derive deux fois

`results.mjs` acceptait n'importe quel mot et `rows.mjs` gardait sa propre carte des mots
lisibles : un runner inventant un verdict rendait le reconciliateur FAUX sur le tableau
(`INCONCLUSIVE` pour PIN-11, puis `SETUP-FAILED` pour HEAL-W2, sous le commentaire qui
l'annoncait). La liste vit desormais dans `verdicts.mjs`, importee des deux cotes et refusee AU
JET ; `verdict-selftest.mjs` la tient - rejoue avant les deux incidents, son balayage nomme les
seize appels fautifs.
[README](tools/cross-client-harness/README.md), [testing-methodology](docs/wiki/testing-methodology.md)
