### Fixed - le login de la campagne s'arretait sur un chrono et accusait l'app d'un echec qui n'existait pas

La boucle finissait quand l'URL quittait `/auth/callback`, puis lisait la session une seule fois,
apres coup : un echange lent et un echange REFUSE sortaient le meme texte, et le `throw` disait "la
session n'a pas ete ecrite" d'un login qui avait reussi. Elle se termine desormais sur le fait que
l'appelant attend - `canari_saved_user`, ecrit par `handleOidcCallback` avant toute porte de PIN - et
quand la borne est atteinte elle NOMME laquelle des trois causes elle a vue.
[login.mjs](tools/cross-client-harness/login.mjs)
