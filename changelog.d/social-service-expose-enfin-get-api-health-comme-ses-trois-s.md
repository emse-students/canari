### Added - social-service expose enfin `GET /api/health`, comme ses trois soeurs

Les trois autres services NestJS exposent cette route depuis un `HealthController` a
`@Controller()` vide ; social-service n'en avait aucune, et sa sonde la plus proche etait
`GET /api/channels/health`, qui appartient au `ChannelsController` et repond sur le service de
canaux. Le healthcheck de production et le boot test interrogent desormais la meme URL que les
autres ; la route de canaux reste, le front l'appelle.
[social-service](apps/social-service/src/health.controller.ts)
