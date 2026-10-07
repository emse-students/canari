import { m } from '$lib/paraglide/messages';
import type { Association } from '$lib/associations/api';

/** The three things the association API stores: the noun a screen speaks in follows from it. */
export type AssociationKind = Association['type'];

/**
 * THE ONE PLACE A SCREEN LEARNS WHICH NOUN TO USE FOR AN ASSOCIATION, A LIST OR AN INSTITUTION.
 *
 * The edit pages are shared by the three kinds, and each used to carry its own ternary over the
 * wording - which is how an institution came to read "Supprimer l'association ?". A kind is added
 * HERE (one row, every message) or not at all; a component never branches on the kind to pick a
 * sentence. Lazy because a Paraglide message must be called at render time, never at module init.
 */
interface KindWording {
  /** `<title>` and heading of the edit page. */
  editTitle: () => string;
  /** The directory a deleted entity lands back on. */
  directoryHref: '/associations' | '/lists' | '/institutions';
  /** The button on the public page that leads to the edit page. */
  manageButton: () => string;
  /** Placeholder of the profile tab's short description field. */
  descriptionPlaceholder: () => string;
  /** Intro line of the shop tab, naming the public page the products also appear on. */
  boutiqueSubtitle: () => string;
  danger: {
    archiveTitleArchived: () => string;
    archiveTitle: () => string;
    archivedDesc: () => string;
    unarchivedDesc: () => string;
    reactivate: () => string;
    archive: () => string;
    deleteDesc: () => string;
    delete: () => string;
    archiveConfirm: () => string;
    deleteConfirm: () => string;
  };
  lydia: {
    intro: () => string;
    nameLabel: () => string;
    disconnectConfirm: () => string;
    validateConfirm: () => string;
  };
}

const WORDING: Record<AssociationKind, KindWording> = {
  association: {
    editTitle: () => m.asso_edit_page_title(),
    directoryHref: '/associations',
    manageButton: () => m.asso_manage_button(),
    descriptionPlaceholder: () => m.asso_edit_description_placeholder(),
    boutiqueSubtitle: () => m.asso_boutique_subtitle(),
    danger: {
      archiveTitleArchived: () => m.asso_danger_archive_title_archived_asso(),
      archiveTitle: () => m.asso_danger_archive_title_asso(),
      archivedDesc: () => m.asso_danger_archived_desc_asso(),
      unarchivedDesc: () => m.asso_danger_unarchived_desc_asso(),
      reactivate: () => m.asso_danger_reactivate_asso(),
      archive: () => m.asso_danger_archive_asso(),
      deleteDesc: () => m.asso_danger_delete_desc_asso(),
      delete: () => m.asso_danger_delete_asso(),
      archiveConfirm: () => m.asso_danger_archive_confirm_asso(),
      deleteConfirm: () => m.asso_danger_delete_confirm_asso(),
    },
    lydia: {
      intro: () => m.asso_lydia_intro(),
      nameLabel: () => m.asso_lydia_name_label(),
      disconnectConfirm: () => m.asso_lydia_disconnect_confirm(),
      validateConfirm: () => m.asso_lydia_validate_confirm(),
    },
  },
  list: {
    editTitle: () => m.asso_edit_page_title(),
    directoryHref: '/lists',
    manageButton: () => m.asso_manage_list_button(),
    descriptionPlaceholder: () => m.asso_edit_description_placeholder(),
    boutiqueSubtitle: () => m.asso_boutique_subtitle(),
    danger: {
      archiveTitleArchived: () => m.asso_danger_archive_title_archived_list(),
      archiveTitle: () => m.asso_danger_archive_title_list(),
      archivedDesc: () => m.asso_danger_archived_desc_list(),
      unarchivedDesc: () => m.asso_danger_unarchived_desc_list(),
      reactivate: () => m.asso_danger_reactivate_list(),
      archive: () => m.asso_danger_archive_list(),
      deleteDesc: () => m.asso_danger_delete_desc_list(),
      delete: () => m.asso_danger_delete_list(),
      archiveConfirm: () => m.asso_danger_archive_confirm_list(),
      deleteConfirm: () => m.asso_danger_delete_confirm_list(),
    },
    // Payments are not offered on a list: these are the association sentences, never drawn.
    lydia: {
      intro: () => m.asso_lydia_intro(),
      nameLabel: () => m.asso_lydia_name_label(),
      disconnectConfirm: () => m.asso_lydia_disconnect_confirm(),
      validateConfirm: () => m.asso_lydia_validate_confirm(),
    },
  },
  institution: {
    editTitle: () => m.asso_edit_page_title_institution(),
    directoryHref: '/institutions',
    manageButton: () => m.asso_manage_button_institution(),
    descriptionPlaceholder: () => m.asso_edit_description_placeholder_institution(),
    boutiqueSubtitle: () => m.asso_boutique_subtitle_institution(),
    danger: {
      archiveTitleArchived: () => m.asso_danger_archive_title_archived_institution(),
      archiveTitle: () => m.asso_danger_archive_title_institution(),
      archivedDesc: () => m.asso_danger_archived_desc_institution(),
      unarchivedDesc: () => m.asso_danger_unarchived_desc_institution(),
      reactivate: () => m.asso_danger_reactivate_institution(),
      archive: () => m.asso_danger_archive_institution(),
      deleteDesc: () => m.asso_danger_delete_desc_institution(),
      delete: () => m.asso_danger_delete_institution(),
      archiveConfirm: () => m.asso_danger_archive_confirm_institution(),
      deleteConfirm: () => m.asso_danger_delete_confirm_institution(),
    },
    lydia: {
      intro: () => m.asso_lydia_intro_institution(),
      nameLabel: () => m.asso_lydia_name_label_institution(),
      disconnectConfirm: () => m.asso_lydia_disconnect_confirm_institution(),
      validateConfirm: () => m.asso_lydia_validate_confirm_institution(),
    },
  },
};

/** The wording of one kind; every screen sharing an edit flow reads its sentences from here. */
export function wordingFor(kind: AssociationKind): KindWording {
  return WORDING[kind];
}
