### Fixed - an image or vault document over 8 MiB is refused with a message instead of spinning

The association vault and every raw image upload now refuse a body the host firewall would drop, before sending it ([host-waf-body-limit](docs/wiki/infrastructure/host-waf-body-limit.md)).
