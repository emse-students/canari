//! Phase 3 baseline benchmarks for `mls-core` hot paths.
//!
//! Run from repo root:
//!   cd frontend/mls-core && cargo bench -p mls-core --bench mls_perf
//!
//! Quick smoke (no stats):
//!   cd frontend/mls-core && cargo bench -p mls-core --bench mls_perf -- --test

mod support;

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use mls_core::MlsManager;
// `criterion::black_box` is a re-export deprecated in criterion 0.8 in favour of the std one,
// stable since Rust 1.66 and so available on every toolchain this repository accepts. Naming
// std directly makes the bench compile on either criterion version.
use std::hint::black_box;
use support::{build_decrypt_fixture, build_persistence_fixture};

/// A LOGGER THAT DISCARDS EVERYTHING, INSTALLED SO THE BENCHES MEASURE WHAT A DEVICE PAYS.
///
/// `log::info!` expands to `if level_enabled { ... }`, so with no logger installed `log::max_level()`
/// is `Off` and **its ARGUMENTS are never evaluated**. Two of `load_or_create`'s arguments are
/// `state_composition_summary()` and `key_package_census_summary()`, and the second DESERIALISES
/// every stored key package bundle. A bench run without a logger therefore measures a load that
/// skips them, while a phone - which installs `tauri-plugin-log` at info - pays for both.
///
/// Measured on OXYGEN at a 1000-package pool: **8.2 ms with no logger, 14.9 ms with one**. A bench
/// blind to 45 % of the thing it measures would have reported this path as cheap, which is exactly
/// what the first version of these benches did.
///
/// It discards rather than prints because the ARGUMENT EVALUATION is the cost under test; formatting
/// and writing to a terminal is the harness's own noise, and would be measured as the subject's.
struct DiscardingLogger;
impl log::Log for DiscardingLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, _: &log::Record) {}
    fn flush(&self) {}
}
static DISCARDING_LOGGER: DiscardingLogger = DiscardingLogger;

/// Installs [`DiscardingLogger`] once. `set_logger` is global and one-shot; `set_max_level` is not,
/// so the level is what the benches below move to compare a logged load against an unlogged one.
fn install_logger() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        log::set_logger(&DISCARDING_LOGGER).expect("no other logger in a bench process");
    });
}

const BENCH_KEY: [u8; 32] = [42u8; 32];
const GROUP_COUNTS: [usize; 3] = [5, 20, 50];
const KEY_PACKAGE_POOL: usize = 50;
const DECRYPT_BATCH_SIZES: [usize; 3] = [1, 100, 1000];
/// The key-package pools the LOAD benches sweep.
///
/// 50 is the pool the app intends to hold. 1000 is the shape a production device actually reached -
/// 933 -> 983 -> 1013 read twelve minutes apart on one browser profile on 2026-09-16, with nothing
/// reclaimed. A load bench that only ever sees 50 would report that this path is free and would have
/// said so on every device where it is not.
const LOAD_KEY_PACKAGE_POOLS: [usize; 3] = [50, 500, 1000];
/// The group count a load bench holds fixed: what the user's own device carries.
const LOAD_GROUP_COUNT: usize = 5;

fn bench_save_state_cold_rebuild(c: &mut Criterion) {
    let mut group = c.benchmark_group("save_state_plain_cbor_cold_rebuild");
    group.sample_size(30);

    for group_count in GROUP_COUNTS {
        let fixture = build_persistence_fixture(group_count, KEY_PACKAGE_POOL);
        group.throughput(Throughput::Bytes(fixture.plain_bytes_len as u64));
        group.bench_with_input(
            BenchmarkId::new("groups", format!("{group_count}_kp_{KEY_PACKAGE_POOL}")),
            &fixture,
            |b, f| {
                b.iter(|| {
                    f.manager.invalidate_persisted_snapshot();
                    let bytes = f
                        .manager
                        .save_state()
                        .expect("cold save_state should succeed");
                    black_box(bytes);
                });
            },
        );
    }
    group.finish();
}

/// Repeated `save_state` with no intervening mutations — exercises CBOR cache hit path.
fn bench_save_state_cached_hit(c: &mut Criterion) {
    let fixture = build_persistence_fixture(20, KEY_PACKAGE_POOL);
    fixture
        .manager
        .save_state()
        .expect("warm cache before cached-hit bench");

    let mut group = c.benchmark_group("save_state_plain_cbor_cached_hit");
    group.throughput(Throughput::Bytes(fixture.plain_bytes_len as u64));
    group.bench_function("groups/20_kp_50", |b| {
        b.iter(|| {
            let bytes = fixture.manager.save_state().expect("cached save_state");
            black_box(bytes);
        });
    });
    group.finish();
}

fn bench_save_encrypted(c: &mut Criterion) {
    let mut group = c.benchmark_group("save_state_encrypted_with_key");
    group.sample_size(20);

    for group_count in GROUP_COUNTS {
        let fixture = build_persistence_fixture(group_count, KEY_PACKAGE_POOL);
        group.throughput(Throughput::Bytes(fixture.plain_bytes_len as u64));
        group.bench_with_input(
            BenchmarkId::new("groups", format!("{group_count}_kp_{KEY_PACKAGE_POOL}")),
            &fixture,
            |b, f| {
                b.iter(|| {
                    let bytes = f
                        .manager
                        .save_encrypted_with_key(&BENCH_KEY)
                        .expect("save_encrypted_with_key should succeed");
                    black_box(bytes);
                });
            },
        );
    }
    group.finish();
}

fn bench_send_message(c: &mut Criterion) {
    let mut bob = support::make_manager("bench-bob-send", "dev-b");
    let mut alice = support::make_manager("bench-alice-send", "dev-a");
    let group_id = "bench-send".to_string();
    alice.create_group(group_id.clone()).expect("create_group");
    let kp = bob.generate_key_package().expect("key_package");
    let (_c, welcome, _added, _skipped) = alice
        .add_members_bulk(&group_id, &[&kp])
        .expect("add_members_bulk");
    alice
        .merge_pending_commit_for(&group_id)
        .expect("merge add commit");
    let rt = alice
        .export_ratchet_tree_for(&group_id)
        .expect("export ratchet tree");
    bob.process_welcome(welcome.as_deref().expect("welcome"), Some(&rt))
        .expect("process_welcome");

    let payload = b"bench outbound payload";

    c.bench_function("send_message_single", |b| {
        b.iter(|| {
            let ct = bob
                .send_message(&group_id, black_box(payload))
                .expect("send_message");
            black_box(ct);
        });
    });
}

fn bench_process_incoming(c: &mut Criterion) {
    let mut group = c.benchmark_group("process_incoming_message");
    group.sample_size(30);

    for msg_count in DECRYPT_BATCH_SIZES {
        let fixture = build_decrypt_fixture(msg_count);
        let plain_state = fixture
            .receiver
            .save_state()
            .expect("receiver save_state for bench reset");
        let ciphertexts = fixture.ciphertexts.clone();
        let group_id = fixture.group_id.clone();

        group.throughput(Throughput::Elements(msg_count as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(msg_count),
            &msg_count,
            |b, _| {
                b.iter(|| {
                    let mut receiver = MlsManager::load_or_create(
                        "bench-alice",
                        "dev-a",
                        Some(plain_state.clone()),
                    )
                    .expect("restore receiver state");
                    for ct in &ciphertexts {
                        let plain = receiver
                            .process_incoming_message(&group_id, black_box(ct.as_slice()))
                            .expect("process_incoming_message");
                        black_box(plain);
                    }
                });
            },
        );
    }
    group.finish();
}

fn bench_process_incoming_batch(c: &mut Criterion) {
    let mut group = c.benchmark_group("process_incoming_messages_batch");
    group.sample_size(30);

    for msg_count in DECRYPT_BATCH_SIZES {
        let fixture = build_decrypt_fixture(msg_count);
        let plain_state = fixture
            .receiver
            .save_state()
            .expect("receiver save_state for bench reset");
        let ciphertexts = fixture.ciphertexts.clone();
        let message_refs: Vec<&[u8]> = ciphertexts.iter().map(|c| c.as_slice()).collect();
        let group_id = fixture.group_id.clone();

        group.throughput(Throughput::Elements(msg_count as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(msg_count),
            &msg_count,
            |b, _| {
                b.iter(|| {
                    let mut receiver = MlsManager::load_or_create(
                        "bench-alice",
                        "dev-a",
                        Some(plain_state.clone()),
                    )
                    .expect("restore receiver state");
                    let outcomes = receiver.process_incoming_messages(&group_id, &message_refs);
                    black_box(outcomes);
                });
            },
        );
    }
    group.finish();
}

/// WHAT A COLD LOAD COSTS, AND HOW IT GROWS WITH A POOL NOTHING RECLAIMS.
///
/// The user's own boot report on 2026-09-17 put `mls-load-state` at **1644 ms, 82.7 % of everything
/// after `login-start`** - one `invoke('initialiser_mls')` for five groups - and nothing in this
/// crate could say which part of it. Every bench here measured SAVING; the path that runs once per
/// cold start, on the critical path of the first screen, had none.
///
/// The pool is the swept dimension rather than the group count because the two O(n) passes below
/// walk key packages, not groups, and because the accumulation is the thing already known to be
/// unbounded.
fn bench_load_or_create(c: &mut Criterion) {
    install_logger();
    let mut group = c.benchmark_group("load_or_create_cold");
    group.sample_size(20);

    for pool in LOAD_KEY_PACKAGE_POOLS {
        let fixture = build_persistence_fixture(LOAD_GROUP_COUNT, pool);
        let plain = fixture.manager.save_state().expect("snapshot the fixture");
        group.throughput(Throughput::Bytes(plain.len() as u64));

        // INFO, because that is the level a device runs at. See `DiscardingLogger`.
        log::set_max_level(log::LevelFilter::Info);
        group.bench_with_input(
            BenchmarkId::new("kp", format!("{pool}_groups_{LOAD_GROUP_COUNT}")),
            &plain,
            |b, bytes| {
                b.iter(|| {
                    let manager = MlsManager::load_or_create(
                        "bench-user",
                        "bench-device",
                        Some(bytes.clone()),
                    )
                    .expect("cold load should succeed");
                    black_box(manager);
                });
            },
        );

        // THE SAME LOAD WITH THE DIAGNOSTICS SILENCED, so the gap is a number in the bench output
        // rather than a claim in a comment. Anything this pair separates is what the two per-load
        // `log::info!` arguments cost, and nothing else changes between them.
        log::set_max_level(log::LevelFilter::Off);
        group.bench_with_input(
            BenchmarkId::new("kp_unlogged", format!("{pool}_groups_{LOAD_GROUP_COUNT}")),
            &plain,
            |b, bytes| {
                b.iter(|| {
                    let manager = MlsManager::load_or_create(
                        "bench-user",
                        "bench-device",
                        Some(bytes.clone()),
                    )
                    .expect("cold load should succeed");
                    black_box(manager);
                });
            },
        );
        log::set_max_level(log::LevelFilter::Info);
    }
    group.finish();
}

/// THE TWO PASSES A LOAD MAKES OVER EVERY STORED BUNDLE, MEASURED APART FROM IT.
///
/// `load_or_create` does three O(pool) walks on a native target that a reader would not guess from
/// its signature: it prunes expired key packages, it prints a composition summary, and it prints a
/// census that DESERIALISES every bundle. All three are diagnostics or maintenance, all three sit on
/// the cold-start critical path, and the comment on the census already says in as many words that
/// "the web start-up is not where an O(n) diagnostic belongs" - while leaving it on the native one.
///
/// Whether that is worth anything is a question about NUMBERS, and this is what produces them. The
/// point is the RATIO to the bench above: a pass that is 2 % of a load is a diagnostic worth keeping
/// and one that is 40 % is the answer to the user's cold-start target.
fn bench_load_passes(c: &mut Criterion) {
    install_logger();
    let mut group = c.benchmark_group("load_per_pool_passes");
    group.sample_size(20);

    for pool in LOAD_KEY_PACKAGE_POOLS {
        let fixture = build_persistence_fixture(LOAD_GROUP_COUNT, pool);

        group.bench_with_input(
            BenchmarkId::new("prune_expired", pool),
            &fixture.manager,
            |b, manager| {
                // Nothing is expired in a fixture minted seconds ago, so this measures the WALK -
                // which is what a load pays on every start, since a device with nothing to reclaim
                // is the ordinary case and the expensive one is strictly worse.
                b.iter(|| black_box(manager.prune_expired_key_packages().expect("prune")));
            },
        );

        group.bench_with_input(
            BenchmarkId::new("census", pool),
            &fixture.manager,
            |b, manager| {
                b.iter(|| black_box(manager.key_package_census_summary()));
            },
        );

        group.bench_with_input(
            BenchmarkId::new("composition", pool),
            &fixture.manager,
            |b, manager| {
                b.iter(|| black_box(manager.state_composition_summary()));
            },
        );
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_save_state_cold_rebuild,
    bench_save_state_cached_hit,
    bench_save_encrypted,
    bench_send_message,
    bench_process_incoming,
    bench_process_incoming_batch,
    bench_load_or_create,
    bench_load_passes
);
criterion_main!(benches);
