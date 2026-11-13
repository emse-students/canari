## Reading owed - a cold-start export, parse time against the first console line

target: 1.7.0

Two chunks (the chat engine, 404 879 B, and the protobuf codec, 146 160 B) are 44 % of what `/login`
loads, through ONE static import in the root layout (`+layout.svelte`, `globalChatSingleton`);
measurements and what NOT to do (touch the preload header, merge chunks) are on
[cold-start](../frontend/cold-start.md#the-javascript-is-parsed-before-anything-runs-the-delivery-is-solved-measured-on-production-2026-09-16).
**THE NEXT STEP IS STILL A MEASUREMENT, NOT A REFACTOR**: the user's next cold-start export says
whether parse time is the dominant term (the gap between the first console line and `Initialised in WEB
mode`). Splitting the root layout's chat import changes the thing that keeps the session alive across
navigation, and buys nothing on the route the target is measured on.
