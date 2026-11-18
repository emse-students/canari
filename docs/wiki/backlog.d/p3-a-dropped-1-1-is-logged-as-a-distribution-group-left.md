## P3 - a 1:1 dropped because the server no longer lists it is logged "distribution group left"

target: 1.7.1

`forgetMlsGroupIfPresent` (`frontend/src/lib/utils/chat/groupActions.ts`), which drops a group the
server no longer lists, goes through `forgetDistributionGroupById` (`BaseMlsService.ts`) so the tree
and the seed-carrier registration go together. That method passes a fixed reason to
`dropGroupState`: `distribution group left`. So a 1:1 or an ordinary group dropped for being absent
from the server logs `[MLS] dropped local state for <id>... (distribution group left, ...)` - a line
that names a key group which does not exist, and sends whoever reads the log after the wrong
mechanism. In the code since 2026-08-21 (`f950c01c1`), so not a regression of `1.7.0`.

**The fix, about an hour:** the caller states its reason (`forgetDistributionGroupById(groupId,
reason)`), `forgetMlsGroupIfPresent` passing `absent from server`, and the distribution paths
keeping theirs; a unit test on the line each path prints.
