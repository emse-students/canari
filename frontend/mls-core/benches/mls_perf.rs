//! Phase 3 baseline benchmarks for `mls-core` hot paths.
//!
//! Run from repo root:
//!   cd frontend/mls-core && cargo bench -p mls-core --bench mls_perf
//!
//! Quick smoke (no stats):
//!   cd frontend/mls-core && cargo bench -p mls-core --bench mls_perf -- --test

mod support;

use criterion::{BenchmarkId, Criterion, Throughput, black_box, criterion_group, criterion_main};
use mls_core::MlsManager;
use support::{build_decrypt_fixture, build_persistence_fixture};

const BENCH_PIN: &str = "4242";
const GROUP_COUNTS: [usize; 3] = [5, 20, 50];
const KEY_PACKAGE_POOL: usize = 50;
const DECRYPT_BATCH_SIZES: [usize; 3] = [1, 100, 1000];

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
            let bytes = fixture
                .manager
                .save_state()
                .expect("cached save_state");
            black_box(bytes);
        });
    });
    group.finish();
}

fn bench_save_encrypted(c: &mut Criterion) {
    let mut group = c.benchmark_group("save_state_encrypted_argon2");
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
                        .save_encrypted(BENCH_PIN)
                        .expect("save_encrypted should succeed");
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
    let (_c, welcome, _, rt) = alice
        .add_members_bulk(&group_id, &[&kp])
        .expect("add_members_bulk");
    bob.process_welcome(
        welcome.as_deref().expect("welcome"),
        rt.as_deref(),
    )
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
        group.bench_with_input(BenchmarkId::from_parameter(msg_count), &msg_count, |b, _| {
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
        });
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
        group.bench_with_input(BenchmarkId::from_parameter(msg_count), &msg_count, |b, _| {
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
        });
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
    bench_process_incoming_batch
);
criterion_main!(benches);
