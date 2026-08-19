#!/usr/bin/env bash
#
# One egress sample, appended to an NDJSON ledger. Run every minute from cron.
#
# WHY THIS EXISTS
#
# Within one three-minute window on 2026-08-15, two unrelated upstreams timed out from two different
# containers: chat-delivery-service -> Wikipedia at 14:37:02, core-service -> gallery.mitv.fr at
# 14:39:58. Two upstreams failing at once is not evidence about either upstream, and the first
# reading of this shape (an IPv6 problem) was refuted by probing the components, which all came back
# healthy. A one-shot probe CANNOT answer the question that is actually open - whether these stalls
# are CORRELATED - because it only ever says "fine right now".
#
# So this measures the same targets, from the same host, once a minute, and writes down enough per
# sample for `report.py` to separate the causes it cannot itself distinguish:
#
#   - a DNS stall, a TCP stall and a TLS stall are three different diagnoses, so the timings are
#     broken down rather than totalled;
#   - a control target (1.1.1.1) says whether there was any egress at all, which is a different
#     finding from "this upstream was slow";
#   - one probe runs INSIDE the container that made one of the failing calls, because the container
#     path adds Docker's embedded resolver and the bridge NAT to everything the host path has. When
#     the two vantages disagree, the difference IS the answer.
#
# THIS REPOSITORY IS PUBLIC. The sample carries status codes, byte counts and timings only - never a
# response body, never a header, never an environment value.
#
# Usage: ./probe.sh          (appends one sample; prints nothing on success)
# Install: see README.md

set -uo pipefail

LEDGER_DIR="${CANARI_EGRESS_DIR:-/home/canari/egress}"
LEDGER="${LEDGER_DIR}/samples.ndjson"

# 30 days at one sample a minute. A cap on the ledger rather than a logrotate rule, so the file is
# self-limiting wherever it is installed and the retention is visible in the code that writes it.
MAX_SAMPLES=43200

# The container that made one of the two stalled calls. Probing from inside it is what adds the
# Docker resolver and the bridge to the path.
CONTAINER='infrastructure-chat-delivery-service-1'

# 10 s, deliberately longer than the application's 4 s OUTBOUND_BUDGET_MS: a sample that gave up at
# the application's budget could not tell "slow" from "dead", and both matter here.
PROBE_TIMEOUT=10

mkdir -p "${LEDGER_DIR}"

# One target, from the host. Emits a JSON object; every field is a number or a fixed string.
probe_host() {
	local label="$1" url="$2" out
	out=$(curl -sS -o /dev/null -m "${PROBE_TIMEOUT}" \
		-w '%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_total}' \
		"${url}" 2>/dev/null)

	if [ -z "${out}" ]; then
		# curl wrote nothing, so it never got a status. That IS the interesting sample.
		printf '"%s":{"status":0,"dns":null,"connect":null,"tls":null,"total":null}' "${label}"
		return
	fi

	# shellcheck disable=SC2086
	set -- ${out}
	printf '"%s":{"status":%s,"dns":%s,"connect":%s,"tls":%s,"total":%s}' \
		"${label}" "$1" "$2" "$3" "$4" "$5"
}

# The same question from inside the container, through Node's own fetch - which is the exact client
# the application uses, so a difference between this and the host probe is a Docker-layer finding.
probe_container() {
	local label="$1" url="$2" out
	out=$(docker exec "${CONTAINER}" node -e "
		const started = process.hrtime.bigint();
		fetch('${url}', { signal: AbortSignal.timeout(${PROBE_TIMEOUT}000) })
			.then((r) => r.status)
			.catch(() => 0)
			.then((status) => {
				const ms = Number(process.hrtime.bigint() - started) / 1e6;
				process.stdout.write(status + ' ' + ms.toFixed(1));
			});
	" 2>/dev/null)

	if [ -z "${out}" ]; then
		# No output means the exec itself failed - the container is gone or Docker is wedged. That is
		# not the same as an unreachable upstream, so it gets its own shape.
		printf '"%s":{"status":null,"total_ms":null}' "${label}"
		return
	fi

	# shellcheck disable=SC2086
	set -- ${out}
	printf '"%s":{"status":%s,"total_ms":%s}' "${label}" "$1" "$2"
}

{
	printf '{"t":"%s",' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	# The two upstreams that stalled in the same window, the tunnel back to ourselves, and a control.
	probe_host 'wikipedia' 'https://en.wikipedia.org/robots.txt'
	printf ','
	probe_host 'gallery' 'https://gallery.mitv.fr/api/health'
	printf ','
	probe_host 'self' 'https://canari-emse.fr/api/version'
	printf ','
	probe_host 'control' 'https://1.1.1.1/'
	printf ','
	probe_container 'wikipedia_container' 'https://en.wikipedia.org/robots.txt'
	printf '}\n'
} >>"${LEDGER}"

# Trim in place, and only when there is something to trim, so the common minute does no file work.
lines=$(wc -l <"${LEDGER}")
if [ "${lines}" -gt "${MAX_SAMPLES}" ]; then
	tail -n "${MAX_SAMPLES}" "${LEDGER}" >"${LEDGER}.trimmed" && mv "${LEDGER}.trimmed" "${LEDGER}"
fi
