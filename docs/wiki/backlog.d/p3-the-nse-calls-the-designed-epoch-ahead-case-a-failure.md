## P3 - the NSE's "direct decrypt failed group=.. locality=.." line still calls the designed epoch-ahead case a failure

`NotificationService.swift` (about line 1210). #3042 classified the case `kind=EpochAhead` on
Android and in Rust. The NSE line should read the kind and log it as informational, naming the
catch-up, so an expected case is not a line its reader learns to skip.
