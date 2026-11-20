### Fixed - a PIN is registered only once confirmed, and the PIN gate never guesses "returning" or shows a keypad to a removed device

A first setup asks "Confirmez votre PIN", and the server registers a PIN only on that confirmed creation (an unlock on an account with no PIN is answered `not-set`, a PIN from before salts is kept); an unanswered `pin-status` shows "Reessayer" instead of an unlock keypad; a removed device sees "Cet appareil a ete retire de votre compte" and "Se deconnecter" ([auth](docs/wiki/frontend/modules/auth.md#pin-and-device-key)).
