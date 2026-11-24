## P1 - the MiConnect editor token's reach

target: 1.8.1

Canari's MiConnect editor token holds a global user-change permission, broader than the profile
corrections and merge marks it exists for. Narrow it to an allowlisted write path (a policy-guarded
flow writing `attributes.profile`, the merge-mark keys and `name` on person, non-superuser accounts),
with detection of any other write meanwhile. The role is in
`infrastructure/authentik/blueprints/80-profile-editor.yaml`; `test-profile-editor.py` asserts what
the token is refused, and gains the refusals of the narrowed path when it lands.
