### A member added to a group no longer shows as a message you typed

On the phone apps, the push preview of "added a member" was stored as a plain message and drew as an own bubble with no subject. A system event is now a banner only; the notice naming who added whom comes from the conversation itself ([fcmCache.ts](frontend/src/lib/utils/chat/fcmCache.ts)).
