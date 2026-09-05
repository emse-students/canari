#!/usr/bin/env node
/**
 * Asserts that every phase DECLARES the devices its scripts actually drive.
 *
 * WHY THIS FILE EXISTS. MUT-18 opens a conversation on the phone. `checks.mjs` said MUT needs
 * `W1 W2`. So the preflight never armed A1, `sameAccountAs` found nothing on port 9333, and the
 * check recorded `SKIPPED - second client not reachable` on every run it was ever asked for - a
 * reason that is true, useless, and points at the cable instead of at the declaration one file away.
 * It had therefore never produced a verdict, and nobody could tell, because a skip reads as a check
 * that was not applicable rather than as one that was misconfigured.
 *
 * A declaration is also what makes a phase carry `CANARI_A1_BUILD`. An undeclared phone means rows
 * landing with no `a1Build` beside `build` - the campaign's own rule for believing a mobile verdict,
 * broken silently by an omission in a list.
 *
 * WHAT IT CANNOT SEE, stated because the gap is the interesting part. This reads the SOURCE for the
 * ways a runner reaches the phone (`PORTS.A1`, `sameAccountAs`, `a1SameAccountAs`,
 * `tauri.localhost`). A runner that reached it some other way would pass here and fail on the rig,
 * so a new door into the phone belongs in `A1_DOORS` below the day it is opened.
 *
 * IT READS FILES, AND A FILE IS NOT ALWAYS A ROW. The twenty-one MUT checks are all `mut.mjs`, so
 * "does this phase touch the phone" is answerable here and "which of its checks do" is not.
 * `PHONE_SCRIPTS` is where a phase says that, and since 2026-08-24 it may say it as a whole
 * INVOCATION (`del.mjs --only 7`) rather than only as a file name - which is what let DEL declare the
 * phone for one row out of eight. What this file can then verify is that the invocation is really one
 * of the phase's, and that its file has a door to the phone; that `--only 7` is the row USING that
 * door is beyond a source scan, and is stated in `del.mjs` beside the check itself.
 *
 * Run: `bun tools/cross-client-harness/checks-selftest.mjs`
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASES, PHONE_SCRIPTS, SCRATCH_SCRIPTS, devicesFor, scriptPath } from "../checks.mjs";
import { codeOnly } from "../srcscan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Every spelling by which a runner reaches A1.
 *
 * `PORTS.A1` is the port itself, `sameAccountAs`/`a1SameAccountAs` are the helpers that attach to
 * the phone as a second device of an account, and `tauri.localhost` is the origin only the phone
 * serves. Add a door here when one is opened; a runner using an unlisted one is invisible to this.
 */
const A1_DOORS = /PORTS\.A1|sameAccountAs|a1SameAccountAs|tauri\.localhost/;

/**
 * Every spelling by which a runner reaches the SCRATCH device.
 *
 * `becomeANewDevice` is the primitive that wipes it and `PORTS.W3` the port itself. A runner reaching
 * W3 by an unlisted door is invisible here, exactly as it is for the phone - so a new one belongs in
 * this pattern the day it is opened.
 */
const W3_DOORS = new RegExp("PORTS" + "\\." + "W3|becomeANewDevice");

/** Whether a runner file contains any door to the phone. Throws if the file is unreadable. */
// A DOOR IS CODE, NOT PROSE. `tauri.localhost` in a COMMENT explaining why `publicAppOrigin()`
// refuses it made this declare that GRP drives the PHONE - the sentence was right, the gate was
// right, only the reading was wrong. `codeOnly` is the one stripper, shared with the origin gate.
function drivesPhone(file) {
  return A1_DOORS.test(codeOnly(readFileSync(scriptPath(file), "utf8")));
}

/** Whether a runner file contains any door to the scratch device. Throws if it is unreadable. */
function drivesScratch(file) {
  return W3_DOORS.test(codeOnly(readFileSync(scriptPath(file), "utf8")));
}

const problems = [];

for (const [name, phase] of Object.entries(PHASES)) {
  // A phase with no script yet declares nothing and drives nothing - the ladder writes those as it
  // reaches them, and an empty phase is a state the campaign tracks rather than a fault.
  if (!phase.scripts.length) continue;

  const files = [...new Set(phase.scripts.map((s) => s.split(" ")[0]))];
  let phoneFiles;
  try {
    phoneFiles = files.filter(drivesPhone);
  } catch (e) {
    problems.push(`${name}: a declared script is unreadable - ${e.message}`);
    continue;
  }
  const declared = phase.needs.includes("A1");

  if (phoneFiles.length && !declared) {
    problems.push(
      `${name} drives the phone (${phoneFiles.join(", ")}) but declares needs=[${phase.needs.join(" ")}]. ` +
        `The preflight will not arm A1, so those checks will SKIP as "not reachable" and any row they ` +
        `do land will carry no a1Build.`,
    );
  }

  if (!phoneFiles.length && declared) {
    problems.push(
      `${name} declares A1 but no script of its own reaches it (${files.join(", ")}). ` +
        `Arming the phone for a phase that never touches it costs a preflight and stamps every row ` +
        `with an a1Build that describes nothing.`,
    );
  }

  // `PHONE_SCRIPTS` narrows a phase's phone requirement to named scripts, which only means anything
  // if the phase declares the phone at all - and only if those scripts are really the ones using it.
  const narrowed = PHONE_SCRIPTS[name];
  if (narrowed) {
    if (!declared) {
      problems.push(
        `${name} lists PHONE_SCRIPTS but does not declare A1 in needs - the narrowing has nothing to narrow.`,
      );
    }
    // BOTH SPELLINGS, because `run.mjs` matches both: a bare file name, and a whole invocation for a
    // file holding several rows of which only one takes the phone.
    const fileOf = (s) => s.split(" ")[0];
    for (const s of narrowed) {
      if (!files.includes(s) && !phase.scripts.includes(s)) {
        problems.push(
          `${name} PHONE_SCRIPTS names ${s}, which is neither one of its scripts nor one of their files.`,
        );
      } else if (!phoneFiles.includes(fileOf(s))) {
        problems.push(`${name} PHONE_SCRIPTS names ${s}, which contains no door to the phone.`);
      }
    }
    for (const s of phoneFiles) {
      if (!narrowed.some((n) => fileOf(n) === s)) {
        problems.push(
          `${name} drives the phone from ${s}, which PHONE_SCRIPTS omits - so a --file run of it ` +
            `would be preflighted WITHOUT A1.`,
        );
      }
    }
  }

  // THE SAME TWO DIRECTIONS FOR THE SCRATCH DEVICE. A declaration nobody verifies drifts, and this
  // one drifts the same way the phone's did: a row that wipes W3 without the phase declaring it is
  // preflighted against a client nobody checked, and a phase declaring W3 that no script touches
  // pays a preflight to stamp every row with a device that took no part.
  const scratchFiles = files.filter(drivesScratch);
  const declaredScratch = phase.needs.includes("W3");
  if (scratchFiles.length && !declaredScratch) {
    problems.push(
      `${name} wipes the scratch device (${scratchFiles.join(", ")}) but declares ` +
        `needs=[${phase.needs.join(" ")}]. The preflight will never look at W3.`,
    );
  }
  if (!scratchFiles.length && declaredScratch) {
    problems.push(`${name} declares W3 but no script of its own touches it (${files.join(", ")}).`);
  }
  const narrowedScratch = SCRATCH_SCRIPTS[name];
  if (narrowedScratch) {
    if (!declaredScratch) {
      problems.push(
        `${name} lists SCRATCH_SCRIPTS but does not declare W3 in needs - the narrowing has nothing ` +
          "to narrow.",
      );
    }
    const fileOfS = (s) => s.split(" ")[0];
    for (const s of narrowedScratch) {
      if (!files.includes(s) && !phase.scripts.some((x) => x === s || x.split(" ")[0] === s)) {
        problems.push(
          `${name} SCRATCH_SCRIPTS names ${s}, which is neither one of its scripts nor one of their files.`,
        );
      } else if (!scratchFiles.includes(fileOfS(s))) {
        problems.push(`${name} SCRATCH_SCRIPTS names ${s}, which contains no door to W3.`);
      }
    }
    for (const s of scratchFiles) {
      if (!narrowedScratch.some((n) => fileOfS(n) === s)) {
        problems.push(
          `${name} wipes W3 from ${s}, which SCRATCH_SCRIPTS omits - so a --file run of it would be ` +
            "preflighted WITHOUT W3.",
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------- devicesFor, by case
//
// The checks above verify the DECLARATIONS agree with the scripts. This block verifies the function
// that READS them, because that is what a `--file` run actually calls and the two can be right
// separately: a correct `PHONE_SCRIPTS` read by a matcher that only understands bare file names
// demands a phone for `del.mjs --only 2`, which is the refusal-with-no-reason the narrowing exists to
// prevent, arriving through the mechanism meant to prevent it.
const cases = [
  // One row in eight takes the phone, and the entry that says so is a whole invocation.
  { file: "del.mjs", args: ["--only", "7"], phase: "DEL", a1: true },
  { file: "del.mjs", args: ["--only", "2"], phase: "DEL", a1: false },
  { file: "del.mjs", args: ["--only", "10"], phase: "DEL", a1: false },
  // THE INVOCATION THAT ACTUALLY EXISTS, and the reason the three above proved nothing: DEL-7 is a
  // destructive row and cannot be run without the flag, so `--only 7` alone is a spelling no session
  // types. It resolved to W1 W2 until 2026-08-27 and DEL-7 ran against an unarmed phone.
  { file: "del.mjs", args: ["--only", "7", "--destructive"], phase: "DEL", a1: true },
  { file: "del.mjs", args: ["--only", "2", "--destructive"], phase: "DEL", a1: false },
  // NARROWED TO NOTHING IS NOT NARROWED TO THE SEVEN. A bare invocation runs all eight rows, DEL-7
  // among them, so it owes the cable however the declaration is written.
  { file: "del.mjs", args: [], phase: "DEL", a1: true },
  { file: "del.mjs", args: ["--destructive"], phase: "DEL", a1: true },
  // A file whose whole subject IS the second device, and the case that started all of this.
  { file: "comm25.mjs", args: [], phase: "COMM", a1: true },
  // A name in no phase: the two browsers, and `phase: null` so the caller can SAY it defaulted.
  { file: "nosuchscript.mjs", args: [], phase: null, a1: false },
  // THE TWO OPTIONAL DEVICES ARE DROPPED INDEPENDENTLY, which is the whole reason there are two maps.
  // HEAL needs the phone for two rows and the scratch profile for seven, and no row needs both: a
  // single verdict would hand `healnew.mjs` a cable it never uses, or refuse `heal-a1.mjs` for want of
  // a profile it never wipes.
  { file: "healnew.mjs", args: ["--row", "1"], phase: "HEAL", a1: false, w3: true },
  { file: "newdevice.mjs", args: [], phase: "HEAL", a1: false, w3: true },
  { file: "heal-a1.mjs", args: [], phase: "HEAL", a1: true, w3: false },
  { file: "heal-web.mjs", args: [], phase: "HEAL", a1: false, w3: false },
  // THE SELECTOR IS SPELT `--row` IN HALF THE RIG, and a matcher that knew only `--only` read every
  // one of those invocations as selecting nothing - which collapses to the file's whole declaration.
  // `roster.mjs --row 10` opens no client at all and was being preflighted for the scratch device
  // that rows 8 and 9 enrol. Safe direction, same fault: a flag the matcher was never shown.
  { file: "roster.mjs", args: ["--row", "10"], phase: "MULTI", a1: false, w3: false },
  { file: "roster.mjs", args: ["--row", "7"], phase: "MULTI", a1: false, w3: false },
  { file: "roster.mjs", args: ["--row", "8"], phase: "MULTI", a1: false, w3: true },
  { file: "roster.mjs", args: ["--row", "9"], phase: "MULTI", a1: false, w3: true },
  // A FLAG THAT IS NOT A SELECTOR MUST NOT SPLIT A ROW IN TWO. `--order` says which direction row 7
  // runs in, not which row - both spellings are the same row and both need the scratch profile.
  {
    file: "healrevoke.mjs",
    args: ["--row", "7", "--order", "first"],
    phase: "HEAL",
    a1: false,
    w3: true,
  },
  {
    file: "healrevoke.mjs",
    args: ["--row", "7", "--order", "last"],
    phase: "HEAL",
    a1: false,
    w3: true,
  },
  // A PHONE ROW OF THE SAME PHASE MUST STILL GET ITS CABLE AND NOT THE PROFILE, which is the whole
  // reason the two narrowings are read independently.
  { file: "multi.mjs", args: ["--only", "3"], phase: "MULTI", a1: true, w3: false },
];
for (const c of cases) {
  const got = devicesFor(c.file, c.args);
  const label = [c.file, ...c.args].join(" ");
  if (got.phase !== c.phase) {
    problems.push(`devicesFor(${label}) resolved phase ${got.phase}, expected ${c.phase}.`);
  }
  if (got.devices.includes("A1") !== c.a1) {
    problems.push(
      `devicesFor(${label}) -> ${got.devices.join(" ")}; A1 ${c.a1 ? "expected" : "not expected"}.`,
    );
  }
  // `w3` is only asserted where the case states it: the other cases predate the scratch device and
  // say nothing about it, and reading an absent field as `false` would assert what nobody declared.
  if ("w3" in c && got.devices.includes("W3") !== c.w3) {
    problems.push(
      `devicesFor(${label}) -> ${got.devices.join(" ")}; W3 ${c.w3 ? "expected" : "not expected"}.`,
    );
  }
  if (!got.devices.includes("W1") || !got.devices.includes("W2")) {
    problems.push(
      `devicesFor(${label}) -> ${got.devices.join(" ")}; both browsers are always owed.`,
    );
  }
}

if (problems.length) {
  for (const p of problems) console.error(`  FAIL ${p}`);
  console.error(`\n${problems.length} phase declaration(s) disagree with their scripts`);
  process.exit(1);
}

const armed = Object.entries(PHASES).filter(([, p]) => p.scripts.length && p.needs.includes("A1"));
console.log(
  `ok   ${Object.values(PHASES).filter((p) => p.scripts.length).length} phase(s) with scripts; ` +
    `${armed.length} declare A1 (${armed.map(([n]) => n).join(" ")})`,
);
console.log("all good");
