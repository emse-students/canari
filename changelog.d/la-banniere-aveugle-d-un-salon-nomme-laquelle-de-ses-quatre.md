### Fixed - la banniere aveugle d'un salon nomme laquelle de ses quatre conditions a manque

`handleChannelMessage: no seed/ciphertext -> generic notification` est un `if` a quatre termes qui
n'en nommait aucun, si bien qu'une graine jamais miroitee et un chiffre que le serveur n'a pas pu
mettre en ligne - une borne de miroir contre le budget FCM de 4 Ko, deux problemes opposes aux
correctifs opposes - imprimaient la meme phrase. La ligne finit desormais par `missing=<termes>`.
Suffixe et non insertion : trois lecteurs lisent cette ligne, dont une regle ancree aux deux bouts,
elargie dans le meme commit avec les deux fixtures qui l'epinglent
([channel-encryption](docs/wiki/protocols/channel-encryption.md#what-is-left)).
