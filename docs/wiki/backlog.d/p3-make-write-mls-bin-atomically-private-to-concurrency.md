## P3 - harden the "only the slot writer writes `mls.bin`" guard: make `write_mls_bin_atomically` private to `concurrency.rs`

Today `only_the_slot_writer_writes_mls_bin` is a source scan refusing a call anywhere else. Making
`write_mls_bin_atomically` private to `concurrency.rs` lets the compiler enforce it, which is the
same rule at a stronger layer ([durable-rules](../durable-rules.md)).
