### Fixed - a comment hidden from the bell no longer silences the next one

The "post already has an unread notification" question of the one-per-post push now asks the bell's own predicate (`bellRowShownSql`), so a row the bell hides (moderation, a post the reader no longer sees) does not make the next comment update quietly ([engagement](docs/wiki/engagement.md)).
