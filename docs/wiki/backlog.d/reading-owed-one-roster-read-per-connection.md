## Reading owed - one roster read per connection

target: 1.7.0

**What is built:** one roster read per connection (#1806, `v1.2.7`)

**The reading that closes it:** a production console: 1 `POST /api/mls/group-rosters` per connection where there were 80-81
