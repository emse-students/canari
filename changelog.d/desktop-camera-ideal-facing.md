### Fixed - desktop Chrome could not open the live or reel camera

A desktop webcam reports no facing, so the exact `facingMode` the live and reel cameras asked for was always refused. The first capture is now ideal on a desktop and stays exact on a phone and on a lens switch, from one shared builder ([reels](docs/wiki/frontend/modules/reels.md)).
