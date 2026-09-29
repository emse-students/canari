## Default Permission

Default permissions for the system-components plugin.

#### Granted Permissions

- Full control of the native tab bar (`configure_tab_bar`,
  `remove_tab_bar`, `show_tab_bar`, `hide_tab_bar`, `select_tab`,
  `set_badge`, `get_tab_bar_insets`).
- Native overlay components (`create_component`, `update_component`,
  `remove_component`).
- `register_listener` / `remove_listener` — required for `onTabSelected` /
  `onComponentEvent` subscriptions.
- macOS window glass (`is_glass_supported`, `set_window_glass`,
  `clear_window_glass`).

#### This default permission set includes the following:

- `allow-configure-tab-bar`
- `allow-remove-tab-bar`
- `allow-show-tab-bar`
- `allow-hide-tab-bar`
- `allow-select-tab`
- `allow-set-badge`
- `allow-get-tab-bar-insets`
- `allow-present-sheet`
- `allow-dismiss-sheet`
- `allow-create-component`
- `allow-update-component`
- `allow-update-components`
- `allow-remove-component`
- `allow-register-listener`
- `allow-remove-listener`
- `allow-is-glass-supported`
- `allow-set-window-glass`
- `allow-clear-window-glass`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`system-components:allow-clear-window-glass`

</td>
<td>

Enables the clear_window_glass command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-clear-window-glass`

</td>
<td>

Denies the clear_window_glass command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-configure-tab-bar`

</td>
<td>

Enables the configure_tab_bar command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-configure-tab-bar`

</td>
<td>

Denies the configure_tab_bar command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-create-component`

</td>
<td>

Enables the create_component command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-create-component`

</td>
<td>

Denies the create_component command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-dismiss-sheet`

</td>
<td>

Enables the dismiss_sheet command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-dismiss-sheet`

</td>
<td>

Denies the dismiss_sheet command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-get-tab-bar-insets`

</td>
<td>

Enables the get_tab_bar_insets command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-get-tab-bar-insets`

</td>
<td>

Denies the get_tab_bar_insets command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-hide-tab-bar`

</td>
<td>

Enables the hide_tab_bar command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-hide-tab-bar`

</td>
<td>

Denies the hide_tab_bar command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-is-glass-supported`

</td>
<td>

Enables the is_glass_supported command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-is-glass-supported`

</td>
<td>

Denies the is_glass_supported command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-present-sheet`

</td>
<td>

Enables the present_sheet command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-present-sheet`

</td>
<td>

Denies the present_sheet command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-register-listener`

</td>
<td>

Enables the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-register-listener`

</td>
<td>

Denies the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-remove-component`

</td>
<td>

Enables the remove_component command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-remove-component`

</td>
<td>

Denies the remove_component command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-remove-listener`

</td>
<td>

Enables the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-remove-listener`

</td>
<td>

Denies the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-remove-tab-bar`

</td>
<td>

Enables the remove_tab_bar command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-remove-tab-bar`

</td>
<td>

Denies the remove_tab_bar command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-select-tab`

</td>
<td>

Enables the select_tab command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-select-tab`

</td>
<td>

Denies the select_tab command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-set-badge`

</td>
<td>

Enables the set_badge command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-set-badge`

</td>
<td>

Denies the set_badge command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-set-window-glass`

</td>
<td>

Enables the set_window_glass command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-set-window-glass`

</td>
<td>

Denies the set_window_glass command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-show-tab-bar`

</td>
<td>

Enables the show_tab_bar command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-show-tab-bar`

</td>
<td>

Denies the show_tab_bar command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-update-component`

</td>
<td>

Enables the update_component command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-update-component`

</td>
<td>

Denies the update_component command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:allow-update-components`

</td>
<td>

Enables the update_components command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`system-components:deny-update-components`

</td>
<td>

Denies the update_components command without any pre-configured scope.

</td>
</tr>
</table>
