### Fixed - un build release PEUT joindre l'estate locale, et deux pages disaient le contraire

`usesCleartextTraffic=true` n'est pose que sur le type debug, mais cet attribut n'est que la
configuration de BASE : `network_security_config.xml` vit dans `src/main/res`, s'applique a tous les
types et nomme `tauri.localhost` et `localhost` dans un `domain-config` qui l'emporte pour eux. Lu
sur l'artefact release lui-meme (`aapt2 dump xmltree` : `cleartextTrafficPermitted=true`, ressource
renommee `res/8G.xml` par le shrinker et conservee). Ce qui manque vraiment a un build release,
c'est la capacite Tauri `local-estate`, que `--config` donne aux deux types.
[README du rig](tools/cross-client-harness/README.md).
