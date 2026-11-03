### Fixed - the social-service suite no longer prints `[CONFIG] FRONTEND_URL is unset`

The refusal test of `frontendBaseUrl()` provoked the accusing error log three times; it now captures and asserts it instead of printing it. Test-only, production unchanged.
