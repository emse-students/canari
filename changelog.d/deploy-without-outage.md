### Fixed - a deploy no longer answers 502 while it runs

A release starts each service's new replica beside the old one, waits for it to be healthy, then drains the old one; the host port moved to a pinned `edge` container. Before, every deploy was 1-2 minutes of "Échec de l'envoi" ([cicd](docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)).
