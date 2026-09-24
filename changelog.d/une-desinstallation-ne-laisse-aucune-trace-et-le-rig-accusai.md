### Fixed - une desinstallation ne laisse aucune trace, et le rig accusait le mauvais cote

Franchir la ligne debug/release exige une desinstallation, qui emporte l'enrolement et `mls.bin` :
c'etait ecrit. Ce qui ne l'etait pas, c'est qu'apres coup le paquet a la bonne version et se lance,
donc rien ne dit que le device est NEUF - seul `firstInstallTime == lastUpdateTime` en temoigne, et
`POST_NOTIFICATIONS` revient a DENIED alors que toute ligne push la suppose accordee. `a1apk.mjs`
lit les deux horloges apres chaque installation et le dit. Son refus nommait aussi le mauvais cote :
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` est symetrique. A1 a perdu son device ainsi le 2026-09-24.
[device-verification](docs/wiki/device-verification.md#before-you-start).
