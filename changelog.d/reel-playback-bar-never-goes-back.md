### Fixed - the CanaReel playback bar no longer goes back while the video loads

The bar was measured against what had loaded so far, which grows with every segment, so on a slow link the position rewound. It is now fixed to the video's real total from the first frame (the publisher's declared length, including a conversation reel's, which was lost on the way) and draws what is loaded in grey under the played part, as YouTube does ([reels](docs/wiki/frontend/modules/reels.md#the-playback-bar-never-goes-back-defect-same-day)).
