## Reading owed - `/forms/success` no longer asks for a form called `success`

target: 1.7.0

**What is built:** `/forms/success` no longer asks for a form called `success`

**The reading that closes it:** after a completed payment on production, social-service logs no `invalid input syntax for type uuid: "success"` (once per payment, so ONE payment settles it)
