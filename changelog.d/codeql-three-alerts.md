### Fixed - three code-scanning alerts closed in the code, not dismissed

The `epoch_rejected` log goes through `sanitizeForLog`, a test imports `vi` before using it, and a test no longer holds a `${...}` string that looks like a template.
