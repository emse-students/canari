### Fixed - a booking that ends at midnight reads 00:00, not 24:00

The booking sheet, its "Jusqu'a" stepper and the free slots of the day grid wrote "23:00 - 24:00". They now write "23:00 - 00:00"; display only, the stored end of a day is unchanged ([bookings](docs/wiki/bookings-chantier.md)).
