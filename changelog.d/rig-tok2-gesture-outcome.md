### Changed - TOK-2 reads the failed Add from the app, not from the click

TOK-2 on `1.4.1-alpha.4` failed on "the gesture failed (it reported success)": the add helper returns once the invite button is pressed and cannot see the outcome. The row now reads W1's own `an invitation added nobody (failed)` line, and forgives the failed Add's narration on TOK-2 alone ([cross-client-campaign-1-4-1](docs/wiki/cross-client-campaign-1-4-1.md)).
