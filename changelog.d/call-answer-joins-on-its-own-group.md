### Changed - an answer on the call ring shows the call at once and joins without waiting for every conversation

Answering on the ring now shows the call screen straight away, connecting, and the call's keys wait only for its own conversation to reach the server's epoch - that conversation caught up first - instead of every conversation's messages (10.7 s on a resumed Android phone) ([calls](docs/wiki/frontend/modules/calls.md#the-answer-joins-on-its-own-group-184-2026-11-28)).
