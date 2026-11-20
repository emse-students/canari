### Fixed - a new PIN is typed twice, and the PIN gate never guesses "returning" or shows a keypad to a removed device

A first setup asks "Confirmez votre PIN"; an unanswered `pin-status` shows "Reessayer" instead of an unlock keypad; a removed device sees "Cet appareil a ete retire de votre compte" and "Se deconnecter" ([auth](docs/wiki/frontend/modules/auth.md#pin-and-device-key)).
