/**
 * A GROUP THIS DEVICE REFUSED AN ADMISSION INTO, and never repairs.
 *
 * `mls-core` refuses, unmerged, a commit that brings a user in on their own into a CLOSED group
 * (`frontend/mls-core/src/admission.rs`). The server - if it is the party that let them in - has
 * accepted that commit and moved the group on, so this device's clean state is now BEHIND it, and
 * every way of catching up runs through the server that served the commit: a commit replay is
 * refused again, and an external join rebuilds this device from the server's group info, which
 * contains the person. Recovery is therefore exactly what must not run.
 *
 * So the freeze is DURABLE STATE, and the single recovery seam reads it before anything
 * (`requestReAdd`, `recoverForkedGroup`, `recoverRosterDisagreement`, the pipeline's epoch-gap
 * escalation). It is lifted by a person, never by a timer or a restart: nothing here expires.
 *
 * Device-wide rather than per account, like the MLS state it protects: a group id names one group.
 */

const STORAGE_KEY = 'canari_admission_frozen';

/** One frozen group: who entered, and when this device saw the refusal. */
export interface AdmissionFreeze {
  groupId: string;
  /** The identity the commit brought in, `userId:deviceId`. */
  entrant: string;
  /** When the refusal was seen (ms) - evidence for the person reading it, never a decision input. */
  at: number;
}

/** Told once, when a group becomes frozen: the session writes the alert (`registerAdmissionAlert`). */
export type AdmissionFreezeListener = (freeze: AdmissionFreeze) => void;

let listener: AdmissionFreezeListener | null = null;

function read(): AdmissionFreeze[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is AdmissionFreeze =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as AdmissionFreeze).groupId === 'string' &&
        typeof (f as AdmissionFreeze).entrant === 'string' &&
        typeof (f as AdmissionFreeze).at === 'number'
    );
  } catch (e) {
    // AN UNREADABLE RECORD CANNOT SAY WHICH GROUPS WERE FROZEN, so none is - which is the permissive
    // answer, on the one store whose job is to keep a repair from running. Marking every group
    // frozen instead would stop all recovery on the device, which is worse. So it accuses at ERROR,
    // and the group's own next refusal freezes it again.
    console.error(
      `[ADMISSION] frozen groups unreadable - none can be read as frozen until the next refusal: ${String(e)}`
    );
    return [];
  }
}

function write(freezes: AdmissionFreeze[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(freezes));
  } catch (e) {
    console.error(
      `[ADMISSION] freeze not persisted, a reload will forget it and a recovery may run: ${String(e)}`
    );
  }
}

/** Registers who is told when a group becomes frozen; `null` unregisters (tests, sign-out). */
export function setAdmissionFreezeListener(next: AdmissionFreezeListener | null): void {
  listener = next;
}

/**
 * Freezes `groupId` after a refused admission, once: a second refusal of the same group neither
 * rewrites the record nor tells the listener again.
 *
 * @returns whether the group became frozen NOW.
 */
export function freezeForAdmissionRefusal(groupId: string, entrant: string): boolean {
  const known = read();
  if (known.some((f) => f.groupId === groupId)) return false;
  const freeze: AdmissionFreeze = { groupId, entrant, at: Date.now() };
  write([...known, freeze]);
  console.error(
    `[ADMISSION] group ${groupId.slice(0, 8)}... FROZEN: ${entrant} entered without a member adding them - no recovery will run`
  );
  try {
    listener?.(freeze);
  } catch (e) {
    console.error(`[ADMISSION] the freeze alert failed, the group stays frozen: ${String(e)}`);
  }
  return true;
}

/** The freeze of `groupId`, or `undefined` when it is not frozen. Read at use, never cached. */
export function admissionFreezeOf(groupId: string): AdmissionFreeze | undefined {
  return read().find((f) => f.groupId === groupId);
}

/** Whether `groupId` was frozen by a refused admission. Read at use, never cached. */
export function isFrozenByAdmissionRefusal(groupId: string): boolean {
  return admissionFreezeOf(groupId) !== undefined;
}

/** Every frozen group, oldest first - what an alert surface lists. */
export function admissionFreezes(): AdmissionFreeze[] {
  return read();
}

/**
 * Lifts a freeze - a PERSON's decision (the conversation was left or deleted). Nothing calls this
 * from a timer, a reconnect or a recovery.
 */
export function liftAdmissionFreeze(groupId: string): void {
  const known = read();
  if (!known.some((f) => f.groupId === groupId)) return;
  write(known.filter((f) => f.groupId !== groupId));
  console.warn(`[ADMISSION] freeze of ${groupId.slice(0, 8)}... lifted by a person`);
}

/** Forgets every freeze (tests only). */
export function resetAdmissionFreezes(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to remove.
  }
  listener = null;
}
