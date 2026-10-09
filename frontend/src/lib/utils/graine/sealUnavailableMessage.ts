import { m } from '$lib/paraglide/messages';
import type { GraineSealUnavailableReason } from './sealUnavailable';

/**
 * The sentence a member reads when a seal was refused, chosen by the TYPED reason the refusal
 * carries - never by its English message.
 *
 * ONE PLACE FOR BOTH SURFACES. A text sent to a salon and a reaction, edit or poll reach the seal
 * through different catches (`sendChatMessage`, `toUiActionError`), and they used to say two
 * different things that were both vaguer than the fact in hand: "Échec de l'envoi" for the first,
 * "pas encore prêt" for the second. The member who reported 2026-10-09's refusals read the first
 * one for ten minutes while the cause was a key-group catch-up that never closed.
 *
 * `key-group-unregistered` and `key-group-not-held` read the same: for the member both mean the
 * join has not landed, and the log line beside the throw keeps them apart.
 */
export function sealUnavailableMessage(reason: GraineSealUnavailableReason): string {
  switch (reason) {
    case 'no-session':
      return m.chat_send_error_seal_no_session();
    case 'unknown-channel':
      return m.chat_send_error_seal_unknown_channel();
    case 'key-group-unregistered':
    case 'key-group-not-held':
      return m.chat_send_error_seal_key_group_missing();
    case 'key-group-unsettled':
      return m.chat_send_error_seal_key_group_unsettled();
    case 'key-group-catching-up':
      return m.chat_send_error_seal_key_group_catching_up();
  }
}
