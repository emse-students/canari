### Changed - opening a salon asks for its history on the press and draws the visible bubbles first

The history request now leaves at the tap instead of after the pane is mounted, and the first frame mounts only the last ~20 message groups, the rest of the entry window following after that frame, so a page of rows is no longer one long task before the first paint ([local-first-ui](docs/wiki/frontend/local-first-ui.md)).
