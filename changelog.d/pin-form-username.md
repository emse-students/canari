### Fixed - every PIN form names its account to the password manager

The unlock gate and the PIN change and recovery forms carry a hidden `autocomplete="username"` field, so Chrome stops flagging a password form with no username and a manager can file the PIN under the account ([PinAccountField](frontend/src/lib/components/auth/PinAccountField.svelte)).
