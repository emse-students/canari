## Reading owed - birthdays on profiles (#3180, first stable `v1.6.9`; birthdays)

target: 1.7.0

**What is built:** birthdays on profiles (#3180, first stable `v1.6.9`; [birthdays](../birthdays.md))

**The reading that closes it:** on dev, a test account whose birthday is the day of the reading (the iPhone account's date set 2026-11-09 is held 30 days, so another account is simpler): the ring on both phones in the feed, the chat list, a conversation and the profile, on a photo and on initials, gone the next day; "C'est son anniversaire aujourd'hui" for a non-follower the visibility hides the date from, no date shown; the morning notice - one bell row and one push per follower allowed the date, Android and iOS (`social_birthday` texts in clear, the tap opening the profile), none again after a social-service restart; `Anniversaires` off - no push, the bell row kept; the settings locked with the day they reopen, the day after a save; one week after the stable, read-only on production: `SELECT visibility, count(*) FROM profile_birthdays GROUP BY 1`
