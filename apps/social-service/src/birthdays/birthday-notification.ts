/**
 * The bell type of the morning notice "C'est l'anniversaire de X" (docs/wiki/birthdays.md); its push
 * key is `social_birthday`. Its own module so the bell's read (`bellRowShownSql`) and the notifier
 * name it without importing each other.
 */
export const BIRTHDAY_NOTIFICATION = 'birthday';
