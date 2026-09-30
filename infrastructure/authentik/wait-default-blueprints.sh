#!/usr/bin/env bash
# Sourced by test-blueprints.sh: waits until authentik's OWN default blueprints have all applied.
#
# WHY IT IS NOT A BARE LOOP. It used to be `until 31/31`, bounded only by the job's 25-minute
# timeout, and it hung there on 2026-09-30 - three PRs went red with "WAIT 30/31" repeated to the
# end and nothing naming the thirty-first. authentik's `apply_blueprint` task marks an instance
# `error` when its validation or a database call fails and NEVER retries it until the file changes
# or the worker restarts, so one lost race at boot is a permanent 30/31, not a slow boot.
#
# So the wait ends on one of three PROOFS instead of a clock:
#   - READY: every instance is `successful`;
#   - a STALL: the count of successful instances has not moved for WAIT_STALL_POLLS polls once it
#     has started moving. That is the state a retry can leave, so the instances that are not
#     `successful` are re-applied ONCE, through the task authentik itself uses, and the warning
#     NAMES them and their status - a fallback is a signal, never a silent path;
#   - a second stall, or WAIT_DEADLINE seconds with nothing applied at all: FAIL, printing what is
#     left and the worker's error lines, because a correct mechanism with no report is found by hand.
#
# `docker` is called by name so a test can put a fake one in front (wait-default-blueprints.test.sh).

probe="from authentik.blueprints.models import BlueprintInstance as B
n = B.objects.count()
ok = B.objects.filter(status='successful').count()
left = ', '.join(f'{b.name}={b.status}' for b in B.objects.exclude(status='successful'))
print(f'READY {ok}/{n}' if n and ok == n else f'WAIT {ok}/{n} {left}')"

resend="from authentik.blueprints.models import BlueprintInstance as B
from authentik.blueprints.v1.tasks import apply_blueprint
for b in B.objects.exclude(status='successful'):
    apply_blueprint.send_with_options(args=(b.pk,), rel_obj=b)
    print(f'RESENT {b.name}={b.status}')"

# wait_for_default_blueprints <worker container>
# Knobs, for the test only: WAIT_POLL (seconds between polls), WAIT_STALL_POLLS, WAIT_DEADLINE.
wait_for_default_blueprints() {
  local worker="$1"
  local poll="${WAIT_POLL:-5}" stall_polls="${WAIT_STALL_POLLS:-12}" deadline="${WAIT_DEADLINE:-600}"
  local started="$SECONDS" state ok=0 last_ok=-1 still=0 resent=0

  while :; do
    # Empty while the worker is still migrating its schema, which is expected and not an error.
    state="$(docker exec "$worker" ak shell -c "$probe" 2>/dev/null | grep -E '^(READY|WAIT) ' || true)"
    case "$state" in
      READY*)
        echo "  $state"
        return 0
        ;;
    esac
    echo "  ${state:-worker not answering yet}"

    if [ -n "$state" ]; then
      ok="${state#WAIT }"
      ok="${ok%%/*}"
      # A stall is only counted once something has applied: a slow first boot sits at 0/N for a
      # while and is not stuck, and the deadline below is what bounds that one.
      if [ "$ok" = "$last_ok" ] && [ "$ok" -gt 0 ]; then still=$((still + 1)); else still=0; fi
      last_ok="$ok"
    fi

    if [ "$still" -ge "$stall_polls" ]; then
      if [ "$resent" -eq 0 ]; then
        echo "::warning::default blueprints stalled with $ok applied: $state - re-applying what is not successful"
        docker exec "$worker" ak shell -c "$resend" 2>&1 | grep -E '^RESENT ' | sed 's/^/  /' || true
        resent=1
        still=0
      else
        echo "::error::default blueprints stalled AGAIN after a re-apply: $state"
        docker logs "$worker" 2>&1 | grep -iE 'error|fail|exception' | tail -20 | sed 's/^/  worker: /' || true
        return 1
      fi
    fi

    if [ $((SECONDS - started)) -ge "$deadline" ]; then
      echo "::error::default blueprints still not applied after ${deadline}s: ${state:-the worker never answered}"
      docker logs "$worker" 2>&1 | grep -iE 'error|fail|exception' | tail -20 | sed 's/^/  worker: /' || true
      return 1
    fi
    sleep "$poll"
  done
}
