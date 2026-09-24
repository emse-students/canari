### Changed - l'etape 2 du check R n'est plus bloquee par un fixture inexistant

Elle attendait une notification portant une vraie image, et aucun compte de test n'avait d'avatar.
Le premier contournement propose est mort : les avatars viennent de MiGallery, pas d'une colonne
d'ici. Le second marche - une association creee sur l'estate LOCALE, logo televerse par le recadreur
de l'app - et la chaine a repondu sur le build debug (`decodeSampled: 512x512 -> inSampleSize=2`,
`largeIcon=true`). Reste la meme mesure sur l'artefact retreci : `bun a1apk.mjs --release`, dont
l'installation coute le device. La recette du fixture est consignee.
[device-verification](docs/wiki/device-verification.md#r-the-shrunk-release-apk-actually-runs---owed-on-android).
