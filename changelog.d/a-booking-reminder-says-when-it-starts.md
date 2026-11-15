### Fixed - a booking reminder says when the booking starts, and the list chip says which day it fires

The bell row read "commence bientot" even for a 24 h reminder, and the list chip showed only "14:00",
which read as the start time. The row now says "dans 15 min" / "demain a 14:00" as of the sending, the
push body leads with the date when it goes out the day before, and the chip names the day and hides
once the reminder went out ([bookings-chantier](docs/wiki/bookings-chantier.md)).
