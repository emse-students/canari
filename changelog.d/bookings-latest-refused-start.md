### Fixed - a refused booking start retires every earlier start

The booking view kept each refused start apart, so a device clock behind the server's meant one refusal per unit. It now keeps the latest refused start and offers none at or before it ([bookings-chantier](docs/wiki/bookings-chantier.md)).
