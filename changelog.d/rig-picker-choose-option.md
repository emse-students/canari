### Fixed - the test rig chooses options of the in-app Picker by their drawn label

`chooseOption` looked for a native select that #1227 replaced, so `venue.mjs` failed `no-select` and every role gesture with it; it now opens the Picker and clicks the option by its Paraglide label, with a selftest over fixture markup ([cross-client-harness](tools/cross-client-harness/README.md)).
