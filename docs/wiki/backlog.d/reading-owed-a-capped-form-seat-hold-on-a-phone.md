## Reading owed - "Réserver ma place" on a capped form, on a phone

target: 1.8.2

Built in the pull request of migration 186 ([forms](../frontend/modules/forms.md#a-capped-form-may-hold-a-seat-for-10-minutes-behind-reserver-ma-place-owner-2026-11-17-migration-186)).
The server side is proven on PostgreSQL; what is owed is the page, on a dev pre-release, on a phone: a capped
named form with one seat left - press "Réserver ma place" (the countdown appears), read the form as a second
account (it says full), let the first account's countdown run out (the card says the reservation expired, a
second account can now answer), then press again and send the answer (the card goes, the seat stays taken).
Close this entry with that reading.
