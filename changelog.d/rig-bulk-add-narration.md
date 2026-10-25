### Fixed - a bulk Add no longer reads as dirt on its own row

The adder's member-list lines matched a one-member Add only, and the admitted device's two 1.4.x decision lines were unclassified, so FLOOR-2 read `PASS-DIRTY` on its own subject ([harness](tools/cross-client-harness/README.md#the-141-row-runners---mlsrowmjs-rowkitmjs-one-table-per-group)).
