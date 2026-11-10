### Fixed - a feed video opens full screen in CanaReels, and every video can be sought again

A tap on a feed video opens the CanaReels viewer on it at the time it had reached, and closing resumes it there; the conversation viewer is a line and a speaker; every uploaded video declared no length (the muxer's `mvhd` said 0), which showed `0:00` and broke seeking - fixed at the container ([video-player](docs/wiki/frontend/modules/video-player.md#the-owners-decisions-of-2026-11-10---full-screen-is-canareels)).
