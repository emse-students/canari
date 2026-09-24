### Changed - le runner de deploiement demenage avec les estates, il ne disparait pas

Le plan decidait de le supprimer et de deployer en SSH depuis un runner GitHub. La cible ne repond
sur `22` que depuis le reseau du campus, et `443` repond depuis l adresse meme ou `22` expire : le
filtre est par port et en amont de l hote, donc un runner GitHub n a aucune route. Le runner
`canari` est enregistre sur la cible, dans un groupe restreint a ce depot, et volontairement arrete
ET desactive jusqu au demenagement. Les quatre jobs gardent `runs-on: self-hosted` inchange.
[cicd](docs/wiki/cicd.md#self-hosted-runner), [estate-migration](docs/wiki/infrastructure/estate-migration.md).
