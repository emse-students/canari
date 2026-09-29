/**
 * A REAL KeyPackage, minted by the client's WASM crate for `alice-user:dev-a1`, and that device's
 * signature over the bytes `probe` made with `sign_with_device_credential`. The pair is what proves
 * a reader lands on the key the device actually signs with, not merely on 32 bytes.
 */
export const ALICE_KEY_PACKAGE =
  'AAEAASDI0wY88L3ghBWg9JW0JAfqXf56KuPIjGQDk1WakNAJBCBIXK2Q/HqprgxiqDhjnCO3rvQCzciQz6+l6gpFdrUTIiCnoTgOnGmOp6VqVDJalUn326EfhzhZvCr2JS/vwXu5qgABEWFsaWNlLXVzZXI6ZGV2LWExAgABBgABAAIAAwAAAgABAQAAAABqu2zAAAAAAGsqONAAQECLJzs9pCcAfM88Ggj/ogZEl+rjnEIhsCji2OHgdpksHnV1ogLXuEyL06svM2SfqWvGgj1oFEGGAu8Sa4tU2YUBAEBAne/VCekALkJU/Ffe8wUltQoIteK9KxX9Og8ZvwB5EsCkuI5pJwm4KjyNNz6srzcTJyEr+Tr4fdkTDvYQ8uaWCw==';

/** `alice-user:dev-a1`'s signature over the ASCII bytes `probe`, base64. */
export const ALICE_PROBE_SIGNATURE =
  'ZdLJyOvKj+/hAtDJpGCUbXj3AUdYyygkfrnVzwSG/0G7OQ8G9uDvAYhnpkQNwcKVBEL7iqEwqqUEzDGsrA+eAQ==';
