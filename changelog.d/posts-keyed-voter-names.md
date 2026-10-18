### Fixed - a poll's voter list with two same-named voters

The voter tooltip keyed rows by display name and threw `each_key_duplicate`; rows are keyed by voter id, and the duplicate-form warning fires once per post.
