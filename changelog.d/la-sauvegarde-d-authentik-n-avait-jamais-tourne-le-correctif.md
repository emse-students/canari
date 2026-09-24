### Fixed - la sauvegarde d Authentik n avait jamais tourne, le correctif dormait dans le depot

94 nuits sans `authentik_db.sql.gz`, pas 93 : le checkout de production etait reste a `0.18.22`,
donc le script nocturne ne connaissait pas la variable ajoutee la veille. Cle a commande forcee
installee vers l hote cible, liste blanche attaquee avec temoin, et l echec sur source injoignable
provoque pour de bon. La valeur passe dans `.env.example`, sinon le prochain deploiement la
remplacerait par un defaut nommant la VM ou tourne encore une copie figee.
[backup](infrastructure/backup/README.md).
