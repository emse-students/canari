/**
 * A CAPPED FORM'S SEAT HOLD, AS THE FILL PAGE SEES IT ("Reserver ma place", owner decision of
 * 2026-11-17; forms.md, "A capped form may hold a seat for 10 minutes behind a button").
 *
 * The server keeps the hold and decides everything: whether a seat is free, the ten minutes, the one
 * hold per account and form, and the submit that spends it. The page only draws it - the button, the
 * countdown, the expired state - and counts down from the SECONDS the server answered, on the
 * browser's monotonic clock: never from a wall clock, whose offset to the server it cannot know.
 */

/** The live hold as `GET forms/:id/check` and `POST forms/:id/seat-hold` name it. */
export interface SeatHoldView {
  /** What the hold has left, read from the server's database clock when it answered. */
  secondsLeft: number;
}

/** What the page knows when it decides whether to offer the button. */
export interface SeatHoldOfferState {
  /** The form's capacity: a form with none holds no seat. */
  maxSubmissions: number | null | undefined;
  /** An anonymous form holds none: a hold names its holder. */
  anonymous: boolean | null | undefined;
  signedIn: boolean;
  formFull: boolean;
  submitted: boolean;
  editing: boolean;
  closed: boolean;
  notOpenYet: boolean;
  maySubmit: boolean;
  preview: boolean;
  /** A hold is live now: the button gives way to the countdown. */
  holding: boolean;
}

/**
 * Whether the page offers "Reserver ma place": a signed-in person, on an open capped named form with a
 * seat free, who has not answered and holds no seat yet. The server re-checks every one of these.
 */
export function seatHoldOffered(state: SeatHoldOfferState): boolean {
  return (
    !!state.maxSubmissions &&
    state.maxSubmissions > 0 &&
    !state.anonymous &&
    state.signedIn &&
    !state.formFull &&
    !state.submitted &&
    !state.editing &&
    !state.closed &&
    !state.notOpenYet &&
    state.maySubmit &&
    !state.preview &&
    !state.holding
  );
}

/** The instant (on the monotonic clock, in ms) a hold answered with `secondsLeft` ends. */
export function holdEndsAt(secondsLeft: number, nowMs: number): number {
  return nowMs + Math.max(0, secondsLeft) * 1000;
}

/** Whole seconds a hold has left at `nowMs`, never negative; 0 means it has lapsed. */
export function holdSecondsLeft(endsAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));
}

/** A countdown as "m:ss" ("9:41"). */
export function holdCountdownText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
