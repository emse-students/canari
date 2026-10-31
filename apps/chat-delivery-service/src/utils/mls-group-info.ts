import { readMlsOpaque } from './mls-tls';

/** RFC 9420 `ProtocolVersion.mls10`. */
const MLS10 = 1;
/** RFC 9420 `WireFormat.mls_group_info`. */
const WIRE_FORMAT_GROUP_INFO = 4;
/** RFC 9420 `ExtensionType.ratchet_tree`. */
const EXTENSION_RATCHET_TREE = 2;
/** RFC 9420 `CredentialType.basic` - the only credential this estate mints. */
const CREDENTIAL_BASIC = 1;

/**
 * The BasicCredential identity of the leaf at `leafIndex` in the ratchet tree a stored external-join
 * base carries - or null when that leaf is blank, absent, not a basic credential, or the bytes do
 * not parse.
 *
 * The base is what `export_group_info` produces in `frontend/mls-core`: an `MLSMessage` whose body
 * is a `GroupInfo` (RFC 9420 section 12.4.3) exported WITH the `ratchet_tree` extension (section
 * 12.4.3.3), so the whole public tree is in the clear. Leaf `i` is node `2i` of that tree (section
 * 4.1); every field skipped here is a `<V>` vector or a fixed-width integer, so nothing beyond the
 * TLS presentation language is needed to walk it.
 *
 * WHY THE SERVER READS IT: an external commit may remove only the joiner's own prior leaf (RFC 9420
 * section 12.4.3.2). The commit names the removed leaf by INDEX; its identity is in the tree of the
 * base the joiner built on, which is this row. Nothing here verifies the GroupInfo's signature: the
 * row is what this server stored and served, and a member's client is where the rule is enforced
 * against the tree it holds (`refuse_foreign_external_remove` in `mls-core`).
 */
export function groupInfoLeafIdentity(groupInfoBase64: string, leafIndex: number): string | null {
  const bytes = Buffer.from(groupInfoBase64, 'base64');
  const tree = readRatchetTreeExtension(bytes);
  if (!tree) return null;

  let offset = 0;
  const target = leafIndex * 2;
  for (let node = 0; offset < tree.length; node++) {
    const present = tree[offset];
    offset += 1;
    if (present === 0) {
      if (node === target) return null;
      continue;
    }
    if (present !== 1 || offset >= tree.length) return null;
    const nodeType = tree[offset];
    offset += 1;
    if (nodeType === 1) {
      const leaf = readLeafNode(tree, offset);
      if (!leaf) return null;
      if (node === target) return leaf.identity;
      offset = leaf.next;
    } else if (nodeType === 2) {
      const next = skipParentNode(tree, offset);
      if (next === null) return null;
      offset = next;
    } else {
      return null;
    }
  }
  return null;
}

/** The `optional<Node> ratchet_tree<V>` vector's contents, or null when the base carries none. */
function readRatchetTreeExtension(bytes: Buffer): Buffer | null {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== MLS10) return null;
  if (bytes.readUInt16BE(2) !== WIRE_FORMAT_GROUP_INFO) return null;
  // GroupContext: version, cipher_suite, group_id<V>, epoch (u64), then tree_hash<V>,
  // confirmed_transcript_hash<V> and extensions<V>.
  const groupId = readMlsOpaque(bytes, 4 + 4);
  if (!groupId) return null;
  let offset = groupId.next + 8;
  for (let i = 0; i < 3; i++) {
    const v = readMlsOpaque(bytes, offset);
    if (!v) return null;
    offset = v.next;
  }
  // GroupInfo.extensions<V>, where the ratchet tree travels.
  const extensions = readMlsOpaque(bytes, offset);
  if (!extensions) return null;
  let at = 0;
  const list = extensions.bytes;
  while (at < list.length) {
    if (list.length < at + 2) return null;
    const type = list.readUInt16BE(at);
    const data = readMlsOpaque(list, at + 2);
    if (!data) return null;
    if (type === EXTENSION_RATCHET_TREE) return readMlsOpaque(data.bytes, 0)?.bytes ?? null;
    at = data.next;
  }
  return null;
}

/**
 * A `LeafNode` (RFC 9420 section 7.2) from `offset`: its BasicCredential identity, and the offset
 * after it. Null for a credential that is not basic, an unknown source, or truncated bytes.
 */
function readLeafNode(bytes: Buffer, offset: number): { identity: string; next: number } | null {
  const encryptionKey = readMlsOpaque(bytes, offset);
  if (!encryptionKey) return null;
  const signatureKey = readMlsOpaque(bytes, encryptionKey.next);
  if (!signatureKey) return null;
  let at = signatureKey.next;
  if (bytes.length < at + 2 || bytes.readUInt16BE(at) !== CREDENTIAL_BASIC) return null;
  const identity = readMlsOpaque(bytes, at + 2);
  if (!identity) return null;
  at = identity.next;
  // Capabilities: versions, cipher_suites, extensions, proposals, credentials - five <V> vectors.
  for (let i = 0; i < 5; i++) {
    const v = readMlsOpaque(bytes, at);
    if (!v) return null;
    at = v.next;
  }
  // leaf_node_source: key_package (lifetime, two u64), update (nothing), commit (parent_hash<V>).
  if (at >= bytes.length) return null;
  const source = bytes[at];
  at += 1;
  if (source === 1) at += 16;
  else if (source === 3) {
    const parentHash = readMlsOpaque(bytes, at);
    if (!parentHash) return null;
    at = parentHash.next;
  } else if (source !== 2) return null;
  const extensions = readMlsOpaque(bytes, at);
  if (!extensions) return null;
  const signature = readMlsOpaque(bytes, extensions.next);
  if (!signature) return null;
  return { identity: identity.bytes.toString('utf8'), next: signature.next };
}

/** Skips a `ParentNode`: encryption_key<V>, parent_hash<V>, unmerged_leaves<V>. */
function skipParentNode(bytes: Buffer, offset: number): number | null {
  let at = offset;
  for (let i = 0; i < 3; i++) {
    const v = readMlsOpaque(bytes, at);
    if (!v) return null;
    at = v.next;
  }
  return at;
}
