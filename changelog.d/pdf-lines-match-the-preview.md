### Fixed - a PDF export breaks its lines where the browser did, not where jsPDF would

The vector text layer re-wrapped every run in jsPDF's own metrics, which printed "Lounes
BRIAND--R / AVIDAT" mid-word and set a name on one line where the preview used two. Each wrapped
run is now measured line by line in the DOM and drawn at its own baseline, on all three exports
(carte, agenda, trombinoscope) ([carte-vie-asso](docs/wiki/carte-vie-asso.md#the-pdf-breaks-its-lines-where-the-browser-did)).
