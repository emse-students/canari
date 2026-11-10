### Operations - 75 production posts stamped as trended, under the owner's explicit yes

On 2026-11-10 at about 19:45 Paris time, `UPDATE posts SET "trendAnnouncedAt" = now() WHERE "trendAnnouncedAt" IS NULL AND "publishedAt" > now() - interval '7 days'` stamped 75 posts. 1.6.9's level-based trend at threshold 4 kept announcing each post to about 500 recipients, with three more bursts after 17:00. The write is reversible and deleted no row ([engagement](docs/wiki/engagement.md#the-deploy-of-2026-11-10-and-what-it-changed)).
