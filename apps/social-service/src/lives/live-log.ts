/**
 * How a lives log line names an account or a live: its first 8 characters - enough to follow one
 * through the logs, never a whole 64-hex account id at info level. ONE definition for the lives
 * module and the moderation of lives.
 */
export const short = (id: string): string => id.slice(0, 8);
