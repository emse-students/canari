### Fixed - la sonde de demarrage des services parle a Garage, l'image MinIO a disparu une deuxieme fois

`quay.io/minio/minio` refuse desormais tout telechargement anonyme (401), apres Docker Hub le
2026-09-11 : toute PR touchant un service NestJS echouait avant ses tests. La sonde demarre
maintenant le Garage que la production utilise, provisionne par le meme mecanisme que
`infrastructure/local` ([cicd](docs/wiki/cicd.md)).
