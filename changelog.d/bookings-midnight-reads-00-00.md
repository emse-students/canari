### Fixed - a booking that ends at midnight reads 00:00, not 24:00

The booking sheet, its "Jusqu'a" stepper, the free slots of the day grid, and the organiser's week painter and time pickers wrote "24:00". They now write "00:00" (the picker's end-of-day choice reads "00:00 (fin de journee)" so it is not mistaken for a start); display only, the stored end of a day is unchanged ([bookings](docs/wiki/bookings-chantier.md)).
