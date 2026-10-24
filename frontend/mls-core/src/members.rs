use openmls::messages::group_info::GroupInfo;
use openmls::prelude::*;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

use crate::device_trust::{
    DeviceTrust, LeafTrust, canonical_identity, canonical_user_id, canonical_user_of,
    identity_names, is_well_formed_identity, key_fingerprint, leaf_keys,
};
use crate::state::MlsManager;
use crate::{
    AddMemberResult, AddMembersBulkResult, AddMembersWithBaseResult, MlsError, SkippedKeyPackage,
    SkippedKeyPackageReason, StagedRemovalResult,
};

/// The binding and pin check every Add runs on a package that already VALIDATED.
///
/// `expected` is the device the package was fetched for; `None` only on the test-and-bench form,
/// which binds no identity (the identity must still be well formed). One function for the Add and
/// for [`MlsManager::vet_key_package`], so the decision a re-add takes BEFORE it removes a stale
/// leaf is the very one the Add then applies.
fn vet_validated(
    trust: &DeviceTrust,
    kp: &KeyPackage,
    expected: Option<&str>,
) -> Result<LeafTrust, SkippedKeyPackageReason> {
    let leaf = kp.leaf_node();
    let identity = match credential_identity(leaf.credential()) {
        Ok(identity) => identity,
        Err(why) => {
            log::error!("[TRUST] KeyPackage refused: its credential is unreadable ({why})");
            return Err(SkippedKeyPackageReason::IdentityMismatch);
        }
    };
    let bound = match expected {
        Some(expected) => identity_names(&identity, expected),
        None => is_well_formed_identity(&identity),
    };
    if !bound {
        log::error!(
            "[TRUST] KeyPackage refused: fetched for {} but its credential names {identity}",
            expected.unwrap_or("a well-formed device identity")
        );
        return Err(SkippedKeyPackageReason::IdentityMismatch);
    }
    let key = leaf.signature_key().as_slice();
    match trust.verdict(&identity, key) {
        LeafTrust::KeyChanged => {
            log::error!(
                "[TRUST] KeyPackage refused: {identity} offers signature key {}, not the one this \
                 device pinned for it - nothing proves the change, so the device is not (re-)added",
                key_fingerprint(key)
            );
            Err(SkippedKeyPackageReason::SignatureKeyChanged)
        }
        other => Ok(other),
    }
}

/// The external-join base for the epoch a staged commit CREATES, in the `MlsMessageOut` wire form
/// the delivery service stores - the same form `export_group_info` produces.
///
/// OpenMLS builds this GroupInfo while building the commit (ratchet tree and external public key
/// included) whenever the group was configured with `use_ratchet_tree_extension(true)`, which every
/// group this crate creates or joins is. It is the ONLY moment the post-commit base can be had:
/// the commit is staged, so this device stays at the old epoch until the server accepts it, and
/// `export_group_info` would describe the base the group is leaving.
///
/// `None` therefore means a group built without the extension - a broken invariant, not a state to
/// degrade around: a commit submitted without its base strands every stateless joiner (COMM-22).
pub(crate) fn successor_base(
    group_info: Option<GroupInfo>,
    group_id: &str,
) -> Result<Vec<u8>, MlsError> {
    let group_info = group_info.ok_or_else(|| {
        log::error!(
            "[BASE] {group_id}: OpenMLS built no GroupInfo for the staged commit - the group lacks the ratchet-tree extension"
        );
        MlsError::OpenMls(format!(
            "no GroupInfo for the staged commit on {group_id}: ratchet-tree extension not set"
        ))
    })?;
    MlsMessageOut::from(group_info)
        .tls_serialize_detached()
        .map_err(|e| MlsError::OpenMls(e.to_string()))
}

/// The identity a credential carries, as the UTF-8 string it was built from.
///
/// Identities are minted in exactly one place (`state.rs`, `userId:deviceId`), so this is the
/// inverse of that and the only place the bytes are turned back into a string - for a leaf of the
/// tree and for the verified sender of a frame alike. The error names what was wrong; the caller
/// names whose credential it was.
pub(crate) fn credential_identity(credential: &Credential) -> Result<String, &'static str> {
    let basic =
        BasicCredential::try_from(credential.clone()).map_err(|_| "not a basic credential")?;
    String::from_utf8(basic.identity().to_vec()).map_err(|_| "identity is not UTF-8")
}

/// The credential identity carried by one leaf.
fn leaf_identity(member: &Member) -> Result<String, MlsError> {
    credential_identity(&member.credential).map_err(|why| {
        MlsError::OpenMls(format!(
            "Invalid credential for member {}: {why}",
            member.index
        ))
    })
}

/// Leaf indices whose identity satisfies `matches`.
///
/// Factored out of the two removal paths, which differ ONLY in that predicate: one names devices,
/// the other names users, and the walk over the tree is the same walk.
fn leaf_indices_where(
    group: &MlsGroup,
    matches: impl Fn(&str) -> bool,
) -> Result<Vec<LeafNodeIndex>, MlsError> {
    let mut leaf_indices: Vec<LeafNodeIndex> = Vec::new();
    for member in group.members() {
        let identity = leaf_identity(&member)?;
        if matches(&identity) {
            leaf_indices.push(member.index);
        }
    }
    Ok(leaf_indices)
}

impl MlsManager {
    // --- C0. SUPPRESSION DE MEMBRE(S) ---

    /// Every leaf's credential identity (`userId:deviceId`) in `group_id`, in leaf order.
    ///
    /// THE TREE IS THE ONLY AUTHORITY ON WHO CAN READ IT. Server-side membership rows answer a
    /// different question - who the delivery service will route to - and can be empty for a group
    /// whose tree is full (a device fresh-start clears them). A reconciliation deciding whether a
    /// leaf still belongs must read this, never the routing table.
    pub fn member_identities(&self, group_id: &str) -> Result<Vec<String>, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        group.members().map(|m| leaf_identity(&m)).collect()
    }

    /// Whether `group_id`'s tree holds ANY leaf of the user `identity` names (`userId:deviceId`, or a
    /// bare user id), read under the one canonical user of [`crate::device_trust::canonical_user_of`].
    ///
    /// The question an AUTOMATIC Add asks before it brings a device in: a device of a user already
    /// in the tree is a member's, one of a user absent from it is a new person, and a new person is
    /// brought in by a member's own gesture - never by a server row or a relayed request, which is
    /// all an automatic Add acts on. The TypeScript twin is `treeHoldsUser` (`leafIdentity.ts`).
    /// An identity naming nobody holds nothing.
    pub fn user_holds_leaf(&self, group_id: &str, identity: &str) -> Result<bool, MlsError> {
        let Some(wanted) = crate::device_trust::canonical_user_of(identity) else {
            return Ok(false);
        };
        Ok(self
            .member_identities(group_id)?
            .iter()
            .any(|leaf| crate::device_trust::canonical_user_of(leaf).as_deref() == Some(&wanted)))
    }

    /// The signature public key of the leaf whose identity is `identity` (`userId:deviceId`) in
    /// `group_id`, or `None` when no leaf carries it.
    ///
    /// What a Graine v2 endorsement is checked against (channel-encryption section 21): the key the
    /// TREE holds for the minting device, which every member of the key group already agreed on -
    /// no new key has to be distributed or trusted. `None` is an answer, not an error: the device
    /// has left the tree, and the caller asks the server's published history instead.
    pub fn member_signature_key(
        &self,
        group_id: &str,
        identity: &str,
    ) -> Result<Option<Vec<u8>>, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        // Matched as the binding matches (one canonical identity): a spelling of a device that IS a
        // leaf must find that leaf, never fall through to the server's published keys.
        for member in group.members() {
            if identity_names(&leaf_identity(&member)?, identity) {
                return Ok(Some(member.signature_key));
            }
        }
        log::debug!("[GRAINE_SIG] no leaf for {identity} in {group_id}");
        Ok(None)
    }

    /// The identity of the leaf of `group_id` whose signature key is `key_package`'s, or `None`
    /// when no leaf carries it.
    ///
    /// For the caller an Add refused as a DUPLICATE SIGNATURE KEY: the refusal says the key is in
    /// the tree, not whose leaf holds it, and treating the duplicate as the identity the package was
    /// fetched for would vouch for, or replace, a device on another device's key. The tree answers
    /// that locally, so it is asked instead of assumed.
    pub fn leaf_holding_key_of(
        &self,
        group_id: &str,
        key_package: &[u8],
    ) -> Result<Option<String>, MlsError> {
        let kp = KeyPackageIn::tls_deserialize(&mut &key_package[..])
            .map_err(|e| {
                MlsError::OpenMls(format!(
                    "leaf_holding_key_of: undecodable KeyPackage: {e:?}"
                ))
            })?
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| {
                MlsError::OpenMls(format!("leaf_holding_key_of: invalid KeyPackage: {e:?}"))
            })?;
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        let key = kp.leaf_node().signature_key().as_slice();
        for member in group.members() {
            if member.signature_key == key {
                let holder = leaf_identity(&member)?;
                log::debug!(
                    "[TRUST] key {} is held by {holder}'s leaf in {group_id}",
                    key_fingerprint(key)
                );
                return Ok(Some(holder));
            }
        }
        log::debug!(
            "[TRUST] key {} is held by no leaf of {group_id}",
            key_fingerprint(key)
        );
        Ok(None)
    }

    /// Remove all leaf nodes whose credential identity matches any of the provided user IDs.
    /// Returns `(commit, group_info)` (see [`StagedRemovalResult`]): the serialized commit that must
    /// be broadcast to all group members, and the external-join base for the epoch it creates,
    /// submitted with it.
    ///
    /// A LEAF IS A DEVICE, AND A USER IS ITS PREFIX. Identities are `userId:deviceId`, so an
    /// exact comparison against a bare user id matched nothing at all and this function could only
    /// ever answer "No member found" - the whole user-level removal path was inert. Matching the
    /// `userId:` prefix is what makes "remove this person, wherever they are signed in" mean what
    /// it says; the colon is part of the prefix so one user id can never swallow another's.
    pub fn remove_members_for_users(
        &mut self,
        group_id: &str,
        user_ids: &[&str],
    ) -> Result<StagedRemovalResult, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        // The user half of the ONE canonical identity, against the canonical user id: a leaf the
        // binding admitted under another spelling of this user is this user's.
        let wanted: Vec<String> = user_ids.iter().map(|u| canonical_user_id(u)).collect();
        let leaf_indices = leaf_indices_where(group, |identity| {
            canonical_user_of(identity).is_some_and(|user| wanted.contains(&user))
        })?;

        if leaf_indices.is_empty() {
            return Err(MlsError::NoSuchMember(format!(
                "no leaf carries any of the identities {:?}",
                user_ids
            )));
        }

        let (commit_msg_out, _welcome, group_info) = group
            .remove_members(&self.provider, &self.keypair, &leaf_indices)
            .map_err(|e| MlsError::OpenMls(format!("RemoveMembers error: {:?}", e)))?;

        // C7-A: do NOT merge here. The commit is only *staged*. The caller validates it
        // server-side THEN calls merge_pending_commit_for (accepted) or clear_pending_commit_for
        // (rejected) - never merge-before-validation again, hence no local fork on rejection.
        // A NEW STAGED COMMIT HAS NO SUBMISSION YET: one left from an earlier commit must never be
        // read as this one's (`pending_submission.rs`).
        self.drop_pending_submission(group_id);
        self.mark_state_dirty();
        let commit = commit_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;
        Ok((commit, successor_base(group_info, group_id)?))
    }

    /// Remove leaf nodes whose credential identity exactly matches any of the provided
    /// `userId:deviceId` strings. Use this to remove a specific device without
    /// affecting other devices of the same user. Returns `(commit, group_info)`, as
    /// [`Self::remove_members_for_users`] does.
    pub fn remove_members_for_devices(
        &mut self,
        group_id: &str,
        device_identities: &[&str],
    ) -> Result<StagedRemovalResult, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        let leaf_indices = leaf_indices_where(group, |identity| {
            device_identities
                .iter()
                .any(|wanted| identity_names(identity, wanted))
        })?;

        // NOTHING TO REMOVE IS ITS OWN ANSWER, not a crypto failure - see `MlsError::NoSuchMember`.
        // The caller that clears a stale leaf must distinguish "the leaf was never there" from "the
        // Remove was refused and the leaf still is", because only the second forbids it from
        // clearing the routing row.
        if leaf_indices.is_empty() {
            return Err(MlsError::NoSuchMember(format!(
                "no leaf carries any of the identities {:?}",
                device_identities
            )));
        }

        let (commit_msg_out, _welcome, group_info) = group
            .remove_members(&self.provider, &self.keypair, &leaf_indices)
            .map_err(|e| MlsError::OpenMls(format!("RemoveMembers error: {:?}", e)))?;

        // C7-A : stage uniquement (cf. remove_members_for_users) - merge/clear par l'appelant
        // apres validation serveur.
        // A NEW STAGED COMMIT HAS NO SUBMISSION YET: one left from an earlier commit must never be
        // read as this one's (`pending_submission.rs`).
        self.drop_pending_submission(group_id);
        self.mark_state_dirty();
        let commit = commit_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;
        Ok((commit, successor_base(group_info, group_id)?))
    }

    /// Stages ONE commit that removes every leaf of the device `identity` and adds it back from
    /// `key_package_bytes` - the repair of a device that asks to be re-added while its leaf is still
    /// in the tree. Staged only: the caller merges or clears after the server answers (C7-A).
    ///
    /// ONE COMMIT, NOT A KICK THEN AN ADD: no epoch ever has the device out of the tree, so a heal
    /// never reads as the user leaving (`removal_epochs` records nothing for it) and a delivery
    /// service cannot steer an honest device into a two-commit shape that would. The Welcome goes to
    /// the re-added device.
    ///
    /// The package is bound and pinned exactly as an Add's is ([`vet_validated`]): a package naming
    /// another device or carrying an unpinned key stages nothing. Its key must also EQUAL the key of
    /// every leaf it removes (matched by [`identity_names`], the one canonical identity), pin or no
    /// pin. No leaf for `identity` is
    /// [`MlsError::NoSuchMember`] - the caller then adds, it does not replace.
    pub fn replace_device_with_base(
        &mut self,
        group_id: &str,
        identity: &str,
        key_package_bytes: &[u8],
    ) -> Result<crate::ReplaceDeviceResult, MlsError> {
        let kp = KeyPackageIn::tls_deserialize(&mut &key_package_bytes[..])
            .map_err(|e| {
                MlsError::OpenMls(format!("replace_device: undecodable KeyPackage: {e:?}"))
            })?
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| MlsError::OpenMls(format!("replace_device: invalid KeyPackage: {e:?}")))?;
        if let Err(reason) = vet_validated(&self.device_trust, &kp, Some(identity)) {
            return Err(MlsError::OpenMls(format!(
                "replace_device: the KeyPackage for {identity} was refused ({})",
                reason.as_str()
            )));
        }
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        let leaf_indices = leaf_indices_where(group, |found| identity_names(found, identity))?;
        if leaf_indices.is_empty() {
            return Err(MlsError::NoSuchMember(format!(
                "no leaf carries {identity} - nothing to replace"
            )));
        }
        // THE TREE IS THE PROOF, NOT ONLY THE PIN: the leaf being removed carries a key signed into
        // a tree this device holds, and the device it names must come back under THAT key. A pin
        // may be missing (a state seeded late, a pin pruned); this evidence is always local.
        let new_key = kp.leaf_node().signature_key().as_slice();
        let removed_keys: Vec<Vec<u8>> = group
            .members()
            .filter(|m| leaf_indices.contains(&m.index))
            .map(|m| m.signature_key)
            .collect();
        if removed_keys.iter().any(|k| k.as_slice() != new_key) {
            log::error!(
                "[TRUST] replace refused: {identity} in {group_id} offers key {}, not the key of the \
                 leaf it would replace - nothing staged",
                key_fingerprint(new_key)
            );
            return Err(MlsError::OpenMls(format!(
                "replace_device: the KeyPackage for {identity} does not carry the key of its leaf"
            )));
        }
        let bundle = group
            .commit_builder()
            .propose_removals(leaf_indices.iter().copied())
            .propose_adds([kp])
            .load_psks(self.provider.storage())
            .map_err(|e| MlsError::OpenMls(format!("replace_device load_psks: {e:?}")))?
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.keypair,
                |_| true,
            )
            .map_err(|e| MlsError::OpenMls(format!("replace_device build: {e:?}")))?
            .stage_commit(&self.provider)
            .map_err(|e| MlsError::OpenMls(format!("replace_device stage: {e:?}")))?;
        let (commit_msg_out, welcome_msg_out, group_info) = bundle.into_messages();
        let welcome_msg_out = welcome_msg_out.ok_or_else(|| {
            MlsError::OpenMls(format!("replace_device: no Welcome for {identity}"))
        })?;
        log::info!(
            "[TRUST] {group_id}: {identity} replaced in one commit ({} leaf/leaves out, one in)",
            leaf_indices.len()
        );
        self.drop_pending_submission(group_id);
        self.mark_state_dirty();
        let commit = commit_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;
        let welcome = welcome_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;
        // `into_messages` hands the base already in its `MlsMessageOut` wire form.
        let base = group_info
            .ok_or_else(|| {
                log::error!(
                    "[BASE] {group_id}: OpenMLS built no GroupInfo for the replace commit - the group lacks the ratchet-tree extension"
                );
                MlsError::OpenMls(format!("no GroupInfo for the staged commit on {group_id}"))
            })?
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;
        Ok((commit, welcome, base))
    }

    /// Merges the group's pending (staged) commit: call AFTER the server accepted the commit
    /// (`validateCommit`). Advances the local epoch. Counterpart of `clear_pending_commit_for`.
    /// [[C7]] Option A: validate-then-merge, never a local fork on rejection.
    ///
    /// Every NEW device the commit put in the tree is recorded ([`crate::device_trust`]), and an
    /// external join of ours pins the tree it joined HERE, once the server took it. The merge is also
    /// observed by Graine's departure tracker (`graine_run.rs`), so a Remove this device commits ends
    /// the run its sessions were minted in. Both happen in [`Self::merge_pending_commit_with_summary`].
    pub fn merge_pending_commit_for(&mut self, group_id: &str) -> Result<(), MlsError> {
        self.merge_pending_commit_with_summary(group_id).map(|_| ())
    }

    /// Whether `key_package_bytes` may be added as the device `expected_identity`, WITHOUT staging
    /// anything: `first-sight` / `pinned` when it may, otherwise the
    /// [`SkippedKeyPackageReason`] wire name an Add would skip it for.
    ///
    /// For the caller that must decide BEFORE staging - the one-commit replace of a device whose leaf
    /// is still in the tree (`replaceMember`). The Add and the replace re-run the same check.
    pub fn vet_key_package(
        &self,
        key_package_bytes: &[u8],
        expected_identity: &str,
    ) -> &'static str {
        match self.key_package_verdict(key_package_bytes, expected_identity) {
            Ok(trust) => trust.as_str(),
            Err(reason) => reason.as_str(),
        }
    }

    /// [`Self::vet_key_package`] as a TYPE: the trust an Add would admit the package under, or the
    /// [`SkippedKeyPackageReason`] it would skip it for - for a Rust caller that branches on it.
    pub fn key_package_verdict(
        &self,
        key_package_bytes: &[u8],
        expected_identity: &str,
    ) -> Result<LeafTrust, SkippedKeyPackageReason> {
        let kp = match KeyPackageIn::tls_deserialize(&mut &key_package_bytes[..]) {
            Ok(kp_in) => kp_in
                .validate(self.provider.crypto(), ProtocolVersion::Mls10)
                .map_err(|e| SkippedKeyPackageReason::from_verify(&e))?,
            Err(_) => return Err(SkippedKeyPackageReason::Undecodable),
        };
        vet_validated(&self.device_trust, &kp, Some(expected_identity))
    }

    /// Hands over every device event recorded since the last call, oldest first, and forgets them
    /// ([`crate::device_trust::DeviceEvent`]). The state is dirtied only when something was taken.
    pub fn take_device_events(&mut self) -> Vec<crate::device_trust::DeviceEvent> {
        let events = self.device_trust.take_events();
        if !events.is_empty() {
            self.mark_state_dirty();
        }
        events
    }

    /// The pending device events, oldest first, LEFT in place - for a background engine that writes
    /// this state back (`mls.bin`), so the app still takes them at its next drain while the engine
    /// raises its own notice from the same events.
    pub fn pending_device_events(&self) -> Vec<crate::device_trust::DeviceEvent> {
        self.device_trust.persisted_events()
    }

    /// The signature keys THIS DEVICE has seen for `user_id:device_id` in a tree it merged or
    /// joined - the single source of trust for "a key this device has seen" - or `None` for a device
    /// it never saw.
    ///
    /// For a verifier of a signature made by a device key (an admission voucher, a signed history
    /// entry): a key the server published alone proves nothing, because the server is the party the
    /// signature must hold against. A pinned key came from a signed tree this device processed.
    ///
    /// `None` MEANS UNVERIFIED, NEVER FORGED: pins are bounded, and past the bound (at load only,
    /// never on a heal's forget) the pin of a device no held tree contains any more is dropped
    /// (`DeviceTrust::prune_absent`), so a device once seen can come back unknown.
    ///
    /// `anchored == false` MEANS THE SAME FOR A CONTRADICTION: the pin was written after that
    /// device's previous pin was pruned, from whatever tree came next, so a signature that fails
    /// under it is unverified, never forged. A signature that VERIFIES under it still proves only
    /// that the key is the one that tree carried.
    ///
    /// Several keys are returned only for a state seeded from trees that disagreed
    /// (`seed_from_tree`); a signature verifying under any of them was made by a key this device saw
    /// for that identity. `reaffirmations` is for the refusal memory, not for verifiers.
    pub fn pinned_signature_keys(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> Option<crate::device_trust::PinView> {
        let pin = self
            .device_trust
            .pin_naming(&format!("{user_id}:{device_id}"));
        if pin.is_none() {
            log::debug!("[TRUST] no pinned key for {user_id}:{device_id} - unverified, not forged");
        }
        pin
    }

    /// The epochs at which this device saw `user_id` LEAVE `group_id`'s tree - a merged commit that
    /// removed the user's last leaf, the epoch being the first one the user is no longer in - oldest
    /// first.
    ///
    /// Recorded at MERGE time, in the one place every merged commit passes (live, replayed on
    /// catch-up, or our own), so every device that merged the commit records it: a kick followed by
    /// a re-add is seen even by a device that only ever observed the tree before and after both.
    /// Compared per user over the trees, so a single commit that swaps a leaf (an external rejoin,
    /// a remove-and-add) and the removal of one device among several record nothing. A kick and a
    /// re-add in TWO commits is a departure, whatever the reason the kick was made.
    ///
    /// TWO PROPERTIES A CALLER RELIES ON: it is PER USER (one device of several leaving is not a
    /// departure), and it holds only commits THIS device merged - a device that entered the group
    /// later, by a Welcome or an external join, knows no departure from before it arrived.
    ///
    /// AN EMPTY ANSWER IS "NOT SEEN", NEVER "NEVER HAPPENED": a commit merged before this record
    /// existed, by a state this device has since lost, before it joined, or dropped past the bound
    /// (`MAX_RECORDED_DEPARTURES`) is absent. Never a device event, never user-visible.
    pub fn removal_epochs(&self, group_id: &str, user_id: &str) -> Vec<u64> {
        self.device_trust.removal_epochs(group_id, user_id)
    }

    /// The trust a leaf with `identity` and `key` would get, without pinning anything.
    pub fn device_key_trust(&self, identity: &str, key: &[u8]) -> LeafTrust {
        self.device_trust.verdict(identity, key)
    }

    /// Clears the group's pending (staged) commit: call when the server REJECTS the commit.
    /// The local epoch stays unchanged (no fork) and a new commit can be generated.
    /// [[C7]] Option A.
    pub fn clear_pending_commit_for(&mut self, group_id: &str) -> Result<(), MlsError> {
        // AN EXTERNAL JOIN HAS NO STATE TO FALL BACK TO: clearing its commit leaves a group this
        // device never entered, holding the tree the server served - which a later load would then
        // pin. The marker goes and the group with it, so nothing of a refused join survives.
        if self.pending_external_joins.remove(group_id) {
            log::warn!(
                "clear_pending_commit_for: {group_id} was an external join not merged - the group is forgotten, its tree never pinned"
            );
            self.forget_group(group_id, 0);
            return Ok(());
        }
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        group
            .clear_pending_commit(self.provider.storage())
            .map_err(|e| MlsError::OpenMls(format!("Clear pending commit error: {:?}", e)))?;
        // A GROUP THE LOAD LEFT UNSEEDED is seeded NOW: with its own commit cleared (and no marker,
        // so it is no external join), the tree it holds is the one this device held before staging -
        // a tree it had accepted, the reason the load seeds every held tree.
        if self.device_trust.forget_unseeded(group_id) {
            log::info!(
                "clear_pending_commit_for: {group_id} was not seeded at load - seeding the tree it falls back to"
            );
            self.device_trust.seed_from_tree(&leaf_keys(group));
        }
        self.drop_pending_submission(group_id);
        self.mark_state_dirty();
        Ok(())
    }

    /// Export the group's current ratchet tree (TLS-serialised). For an ADD this MUST be called
    /// AFTER `merge_pending_commit_for` so the exported tree reflects the post-commit epoch (N+1)
    /// the newly welcomed member joins, not the stale pre-merge tree. [[C7]]
    pub fn export_ratchet_tree_for(&self, group_id: &str) -> Result<Vec<u8>, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        group
            .export_ratchet_tree()
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))
    }

    // --- C. AJOUT DE MEMBRE(S) ---

    /// Add a single key package (kept for backward compat, delegates to bulk).
    pub fn add_member(
        &mut self,
        group_id: &str,
        key_package_bytes: &[u8],
    ) -> Result<AddMemberResult, MlsError> {
        let (commit, welcome, _, _) = self.add_members_bulk(group_id, &[key_package_bytes])?;
        Ok((commit, welcome))
    }

    /// Add multiple members in a single commit so all new members share the same epoch.
    /// Returns `(commit, welcome, added_indices, skipped)` (see
    /// [`AddMembersBulkResult`]). Key packages that fail validation/deserialisation are skipped
    /// and reported via `skipped`, each with its typed reason, so the caller can surface them ([[C5]]) instead of a
    /// silent member loss. Key packages whose identity is already present in the group's tree are
    /// also skipped but NOT reported in `skipped` (re-adding one would make OpenMLS reject
    /// the *entire* commit with `ProposalValidationError(DuplicateSignatureKey)`); this happens
    /// when a previous add attempt merged its commit locally but failed to deliver the
    /// Welcome/commit over the network, leaving a "ghost" member that the caller should detect via
    /// `MlsError::AlreadyMember` (when nothing else was added) and heal by removing then re-adding
    /// that identity.
    ///
    /// **NOT THE PRODUCTION PATH**: it checks the pins but binds no identity, because it is not told
    /// which device each package was fetched for. Both clients stage through
    /// [`Self::add_members_bulk_with_base`], which does; this form serves the tests and benches.
    pub fn add_members_bulk(
        &mut self,
        group_id: &str,
        key_packages_bytes: &[&[u8]],
    ) -> Result<AddMembersBulkResult, MlsError> {
        self.stage_add(group_id, key_packages_bytes, None)
            .map(|(staged, _base)| staged)
    }

    /// [`Self::add_members_bulk`] plus the external-join base for the epoch the staged commit
    /// CREATES (see [`AddMembersWithBaseResult`]). The caller that submits the commit to a server
    /// carries the base with it, so the epoch advance and its base are stored together (COMM-22).
    ///
    /// **`expected_identities[i]` IS THE DEVICE `key_packages_bytes[i]` WAS FETCHED FOR**
    /// (`userId:deviceId`). The bytes came from the delivery service, which chose them, so a package
    /// whose credential names any other device is skipped as `IdentityMismatch`, and one naming the
    /// right device under a key this device has not pinned for it as `SignatureKeyChanged`
    /// ([`crate::device_trust`]). Both are logged at ERROR: neither happens unless somebody
    /// substituted a package. The two slices must be the same length.
    pub fn add_members_bulk_with_base(
        &mut self,
        group_id: &str,
        key_packages_bytes: &[&[u8]],
        expected_identities: &[&str],
    ) -> Result<AddMembersWithBaseResult, MlsError> {
        if expected_identities.len() != key_packages_bytes.len() {
            return Err(MlsError::OpenMls(format!(
                "add_members_bulk_with_base: {} key package(s) for {} expected identit(ies)",
                key_packages_bytes.len(),
                expected_identities.len()
            )));
        }
        self.stage_add(group_id, key_packages_bytes, Some(expected_identities))
    }

    fn stage_add(
        &mut self,
        group_id: &str,
        key_packages_bytes: &[&[u8]],
        expected_identities: Option<&[&str]>,
    ) -> Result<AddMembersWithBaseResult, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        // Keyed by the ONE canonical identity, as the binding reads it: two spellings of one device
        // are one member, in the tree and within this batch.
        let mut known_identities: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for member in group.members() {
            if let Some(identity) = credential_identity(&member.credential)
                .ok()
                .and_then(|id| canonical_identity(&id))
            {
                known_identities.insert(identity);
            }
        }

        // Deserialise and validate each key package, skip invalid ones and ones whose
        // identity is already a member (either already in the tree, or a duplicate within
        // this same batch), tracking the original index of each one kept.
        let mut key_packages: Vec<KeyPackage> = Vec::new();
        let mut added_indices: Vec<u32> = Vec::new();
        // Positions of invalid/unreadable KeyPackages, reported back to the caller (not the
        // already-members, which are a benign dedup). [[C5]]
        // Each carries its typed reason, classified HERE - the only place the openmls error exists.
        let mut skipped: Vec<SkippedKeyPackage> = Vec::new();
        let mut any_already_member = false;
        for (idx, kp_bytes) in key_packages_bytes.iter().enumerate() {
            let kp = match KeyPackageIn::tls_deserialize(&mut &kp_bytes[..]) {
                Ok(kp_in) => match kp_in.validate(self.provider.crypto(), ProtocolVersion::Mls10) {
                    Ok(kp) => kp,
                    Err(e) => {
                        let reason = SkippedKeyPackageReason::from_verify(&e);
                        log::warn!(
                            "Skipping invalid KeyPackage at index {} ({}): {:?}",
                            idx,
                            reason.as_str(),
                            e
                        );
                        skipped.push(SkippedKeyPackage {
                            index: idx as u32,
                            reason,
                        });
                        continue;
                    }
                },
                Err(e) => {
                    log::warn!(
                        "Skipping undeserializable KeyPackage at index {}: {:?}",
                        idx,
                        e
                    );
                    skipped.push(SkippedKeyPackage {
                        index: idx as u32,
                        reason: SkippedKeyPackageReason::Undecodable,
                    });
                    continue;
                }
            };

            // THE DEVICE IT WAS FETCHED FOR, AND THE KEY IT WAS FIRST SEEN WITH - before the dedup,
            // so a package naming somebody else is reported as what it is, not as a member.
            let expected = expected_identities.map(|e| e[idx]);
            if let Err(reason) = vet_validated(&self.device_trust, &kp, expected) {
                skipped.push(SkippedKeyPackage {
                    index: idx as u32,
                    reason,
                });
                continue;
            }

            let identity = credential_identity(kp.leaf_node().credential())
                .ok()
                .and_then(|id| canonical_identity(&id));
            if let Some(identity) = &identity {
                if known_identities.contains(identity) {
                    log::warn!("Skipping KeyPackage already a member of the group");
                    any_already_member = true;
                    continue;
                }
                known_identities.insert(identity.clone());
            }

            added_indices.push(idx as u32);
            key_packages.push(kp);
        }

        if key_packages.is_empty() {
            if any_already_member {
                return Err(MlsError::AlreadyMember(
                    "All KeyPackages already belong to existing group members".to_string(),
                ));
            }
            // Every package was refused: the reasons travel in the error text, for the log only -
            // nothing branches on it (the typed reasons exist only when a commit was staged).
            let reasons: Vec<String> = skipped
                .iter()
                .map(|s| format!("{}={}", s.index, s.reason.as_str()))
                .collect();
            return Err(MlsError::OpenMls(format!(
                "No valid KeyPackages to add (skipped: {})",
                reasons.join(", ")
            )));
        }

        let (commit_msg_out, welcome_msg_out, group_info) = group
            .add_members(&self.provider, &self.keypair, &key_packages)
            .map_err(|e| MlsError::OpenMls(format!("AddMembers error: {:?}", e)))?;

        // C7-A unified: stage only, do NOT merge here. The caller validates the commit server-side
        // then calls merge_pending_commit_for (accepted) or clear_pending_commit_for (rejected), so
        // a server-rejected ADD never leaves the local epoch ahead (no fork). The ratchet tree is
        // exported by export_ratchet_tree_for AFTER the merge (it needs the post-commit epoch N+1
        // state the newly welcomed member joins). [[C7]]
        let commit_bytes = commit_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;
        let welcome_bytes = welcome_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;

        let base = successor_base(group_info, group_id)?;

        // A NEW STAGED COMMIT HAS NO SUBMISSION YET: one left from an earlier commit must never be
        // read as this one's (`pending_submission.rs`).
        self.drop_pending_submission(group_id);
        self.mark_state_dirty();
        Ok((
            (commit_bytes, Some(welcome_bytes), added_indices, skipped),
            base,
        ))
    }
}
