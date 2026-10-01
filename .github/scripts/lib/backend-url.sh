#!/usr/bin/env bash
#
# WHICH ESTATE A BAKED BACKEND URL BELONGS TO - the ONE definition.
#
# `build.yml` (web), `android.yml` and `ios.yml` each baked an assertion of this fact with their own
# list of names. The 2026-09-24 rename moved two and missed the third, and the v0.18.24 stable
# reached both stores but not the site. A change to what production is called is now a change to
# THIS FILE, covered by `.github/scripts/tests/backend-url.test.sh`.
#
# Both production apexes are production: `canari.emse.fr` is the canonical name and
# `canari-emse.fr` still answers for apps already installed. `dev.canari-emse.fr` is matched FIRST
# because it contains the legacy apex as a substring.
#
# Source it; it defines a function and runs nothing.

# Prints `dev`, `production` or `unknown` for the URL on its first argument.
classify_backend_url() {
  case "${1:-}" in
    *"dev.canari-emse.fr"*) printf 'dev\n' ;;
    *"canari.emse.fr"* | *"canari-emse.fr"*) printf 'production\n' ;;
    *) printf 'unknown\n' ;;
  esac
}
