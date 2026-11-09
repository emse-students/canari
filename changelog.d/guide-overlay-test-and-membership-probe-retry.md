### Fixed - a failed membership probe is retried instead of denying the BDE flags for the whole session

The probe behind `/admin` no longer caches a failure as "belongs to nothing": it is a failed state, logged at WARN with its status, and retried once on the next reconnect or navigation. The welcome-tour test no longer re-evaluates the icon barrel per case (430 ms to 75 ms), so it stops timing out under a full parallel run.
