### Fixed - an Android call that replaces another in the call service takes its audio over

The call audio is handed over to the new call, keeping its mode, output and focus, so its focus
events carry the new call's id and a cellular call ending during it gives the microphone back
([calls](docs/wiki/frontend/modules/calls.md#a-call-behaves-like-a-phone-call-2026-10-30-after-the-owners-first-production-call)).
