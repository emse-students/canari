### Fixed - une ligne mesuree sur un client perime est ABSENTE, et non plus en echec

Le ledger estampille `build` depuis le DEPOT : un onglet laisse ouvert a travers un deploiement
ecrit donc une ligne nommant un commit dont son code n'a jamais tourne. TAB-1 a rendu `FAIL`
trois fois le 2026-09-05 contre un correctif que son onglet n'avait jamais charge. `bundle.mjs`
savait le dire depuis le 2026-08-24 et SEUL UN RUNNER le demandait, un fichier a la fois.
`recordObserved` pose desormais la question - la seule place qui connaisse a la fois le verdict et
les clients observes - et la ligne devient `VACUOUS`. Il REFUSE, il ne repare pas : TAB-7 affirme
`neverReloaded`. Au passage, `cdp.mjs` publie `isOpen()` : un client mort coutait 30 002 ms.
[README](tools/cross-client-harness/README.md), [testing-methodology](docs/wiki/testing-methodology.md)
