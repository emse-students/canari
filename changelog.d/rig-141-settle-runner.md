### Added - the 1.4.1 settlement runner (DUP, OFF-1/-2, TOK)

`archive/settle.mjs` plays DUP-1..6, OFF-1/-2 and TOK-1..3 against a commit whose answer is lost, refused, late or cut, judged on the gate's log in order and forgiving exactly the failures its own faults provoke ([README](tools/cross-client-harness/README.md#the-141-row-runners---mlsrowmjs-rowkitmjs-one-table-per-group)).
