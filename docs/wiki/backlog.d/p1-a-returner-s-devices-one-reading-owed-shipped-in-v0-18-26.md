## Reading owed - a returner's devices after the holder election

target: 1.7.0

The election reads presence and waits for an online holder ([channel-encryption](../protocols/channel-encryption.md#wp-33-and-the-answerer-nobody-elects)). **Read on the rig on 2026-11-14** (local estate at `ad2053fc0`, two web seats): a newcomer reaching a salon whose only holder was closed logged `[GRAINE] 1 seed(s) of channel ... wait for a holder to come online - 1 member(s) could answer and none has a device online` and showed nothing from before; once the holder came back it answered (`[GRAINE] answered ... with 1 seed(s)`) and the salon filled. Across the day's rows every ask named one online device (`[GRAINE] asked <member> (<device>)`). **Still owed:** the second community of 2026-09-24, member by member, on production devices. **Residue, not fixed:** a backgrounded Android can hold its socket and look online while unable to answer - the elected member is then silent and the next start re-asks.
