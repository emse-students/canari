### Fixed - a group set to "Aucune" no longer rings an iPhone woken by its silent push

The server already sent such a message silent, but iOS woke the app in the background, which decrypted it before the sign-in read of the notification settings answered and raised it as "all". The device now keeps the account's last answered settings, decides on them until the server answers, and drops a decision left over from a signed-out account ([chat-delivery](docs/wiki/services/chat-delivery.md#a-conversations-notification-level---the-server-applies-none-the-device-decides-mentions)).
