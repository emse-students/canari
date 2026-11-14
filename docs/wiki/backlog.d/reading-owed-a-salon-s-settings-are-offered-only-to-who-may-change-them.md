## Reading owed - a salon's settings are offered only to who may change them

target: 1.7.0

**What is built:** a salon's settings are offered only to who may change them (#1228, `v0.18.32`)

**The reading that closes it:** one look with a Membre account: the access tab reads only, rename and delete are absent; then grant `channel.manage` to Moderateur in the grid with a moderator's panel open - the controls must appear without a reload

**Read 2026-11-14 on dev (`1.6.12-alpha.2`, two desktop Chrome profiles, test accounts):** first half PASS: a Membre sees the Access tab read-only ("only members allowed to manage channels can change these settings"), no Renommer, no Supprimer. Still owed: the Moderateur grid change with a moderator's panel open (needs a community with an admin and a non-admin member on two browsers).
