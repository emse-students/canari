### Changed - every floating surface wears the one glass material, with an opaque fallback

The feed bar's `.glass-chrome` is now the material of the post, community and ecosystem menus, both emoji pickers and the communities sidebar's sticky header; one `--glass-chrome-blur` token turns the blur off, and the surface opaque, where `backdrop-filter` is missing or `prefers-reduced-transparency` is set ([design-reference](docs/wiki/frontend/design-reference.md)).
