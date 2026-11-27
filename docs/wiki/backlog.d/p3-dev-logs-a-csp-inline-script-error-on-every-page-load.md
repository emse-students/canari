## P3 - the dev estate logs one CSP `inline script` refusal on every page load

target: 1.9.2

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Seen 2026-11-17 in a browser console on dev: every page load logs one Content Security Policy
refusal of an inline script. A refusal on every load is noise by the project's rule (a line is
expected and necessary, or the visible end of something upstream), and a refused script is either
dead weight or a behaviour that silently does not run.

Not known yet: which script (the console's hash or the element it names), whether production logs
the same line, and since which build. **What closes it:** name the script, then either move it to a
file the policy already allows or add its hash to the policy where the policy is written
(`infrastructure/local/Dockerfile.frontend`, the one source of the served nginx config), with a test
of the served header; the console of a dev page load then shows no CSP line.

**2026-11-20, [S19](../device-verification.md#the-readings-of-2026-11-20-s19-172-alpha4-the-last-sitting-before-the-stable) (`1.7.2-alpha.4`): the dev web still logs this one line and no other error.
