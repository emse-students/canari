### Fixed - the source-tree test gates no longer time out under the full suite

They read the tree once per file, outside test bodies, and the walker no longer `stat`s every entry ([test-suite-reform](docs/wiki/test-suite-reform.md)).
