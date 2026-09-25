### Fixed - un emoji envoye sans selecteur de variante, comme 📽, s'affichait en caractere

La regle suivait la liste Unicode des caracteres « texte par defaut » (230) ; seuls #, *, les
chiffres, ©, ® et ™ restent desormais du texte sans U+FE0F, comme chez Twemoji et Discord
([emoji](docs/wiki/frontend/emoji.md)).
