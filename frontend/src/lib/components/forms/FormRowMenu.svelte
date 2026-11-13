<script lang="ts">
  /**
   * THE "..." OF ONE FORM'S ROW in the management list: everything a manager does less often than
   * "Modifier" and "Reponses" (which stay on the row, with their words) - open the respondent view,
   * copy the link, show the QR code, export, delete.
   *
   * It is the app's own menu shape (`FloatingSurface` holding a `MenuList`, as `ProfileOverflowMenu`
   * and the form editor's menus): a sheet on a phone, a popover on a wide window. A draft has no
   * link to hand out, so its menu has no link and no QR code. The export entries are the SAME ones
   * `forms/exportEntries.ts` builds, so a grid form offers its two CSVs here too.
   */
  import { Download, Ellipsis, ExternalLink, Link, QrCode, Trash2 } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
  import MenuList from '$lib/components/ui/MenuList.svelte';
  import { OverflowMenuState } from '$lib/components/ui/overflowMenuState.svelte';
  import type { MenuListSection } from '$lib/components/ui/menuList';
  import { exportEntries } from '$lib/forms/exportEntries';
  import type { SubmissionsExportFormat } from '$lib/forms/api';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  interface Props {
    /** A draft is offered neither the link nor the QR code. */
    isDraft: boolean;
    /** Whether the form has a priced grid: its export then offers the two grid CSVs. */
    hasProductGrid: boolean;
    /** The form is being deleted: a second delete is not started. */
    deleting?: boolean;
    onView: () => void;
    onCopyLink: () => void;
    onQr: () => void;
    onExport: (format: SubmissionsExportFormat) => void;
    onDelete: () => void;
  }

  let {
    isDraft,
    hasProductGrid,
    deleting = false,
    onView,
    onCopyLink,
    onQr,
    onExport,
    onDelete,
  }: Props = $props();

  const menu = new OverflowMenuState();

  const EXPORT_PREFIX = 'export:';

  const sections = $derived<MenuListSection[]>([
    {
      items: [
        { key: 'view', label: m.form_view_open_button(), Icon: ExternalLink },
        ...(isDraft
          ? []
          : [
              { key: 'link', label: m.form_list_share_button(), Icon: Link },
              { key: 'qr', label: m.qr_button(), Icon: QrCode },
            ]),
      ],
    },
    {
      title: m.form_list_export_button(),
      items: exportEntries(hasProductGrid).map((entry) => ({
        key: `${EXPORT_PREFIX}${entry.format}`,
        label: entry.label,
        description: entry.hint,
        Icon: Download,
      })),
    },
    { items: [{ key: 'delete', label: m.common_delete_button(), Icon: Trash2, danger: true }] },
  ]);

  function select(key: string) {
    menu.close();
    Log.d('FormRowMenu', `picked ${key}`);
    if (key.startsWith(EXPORT_PREFIX)) {
      onExport(key.slice(EXPORT_PREFIX.length) as SubmissionsExportFormat);
    } else if (key === 'view') onView();
    else if (key === 'link') onCopyLink();
    else if (key === 'qr') onQr();
    else if (key === 'delete' && !deleting) onDelete();
  }
</script>

<span bind:this={menu.anchor} class="inline-flex shrink-0">
  <Button
    variant="secondary"
    icon
    onclick={() => menu.toggle()}
    aria-label={m.form_row_more_actions()}
    title={m.form_row_more_actions()}
    aria-haspopup="menu"
    aria-expanded={menu.open}
    data-testid="form-row-menu"
  >
    <Ellipsis size={16} class="shrink-0" aria-hidden="true" />
  </Button>
</span>

<FloatingSurface
  open={menu.open}
  asSheet={menu.asSheet}
  anchor={menu.anchor}
  label={m.form_row_more_actions()}
  popoverWidth="content"
  onClose={(refocus) => menu.close(refocus)}
>
  <div class="min-w-64">
    <MenuList {sections} label={m.form_row_more_actions()} onSelect={select} />
  </div>
</FloatingSurface>
