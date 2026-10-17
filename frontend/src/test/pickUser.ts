/**
 * Picks a person in a `UserAutocomplete` the way a reader does: types into the field, waits for
 * the debounced search to draw its suggestions, and presses the first one (the option answers
 * `mousedown`, see the component). The caller mocks `apiFetch` to answer the search.
 */
import { expect, vi } from 'vitest';

export async function pickUser(inputId: string, typed: string): Promise<HTMLInputElement> {
  const input = document.getElementById(inputId) as HTMLInputElement;
  input.focus();
  input.value = typed;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const option = await vi.waitFor(
    () => {
      const el = document.querySelector<HTMLElement>(`#${inputId}-listbox [role="option"]`);
      expect(el).not.toBeNull();
      return el!;
    },
    { timeout: 3000 }
  );
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  return input;
}

/** The search field and its form's submit, re-queried: a successful add remounts the field. */
export function addForm(inputId: string) {
  const input = document.getElementById(inputId) as HTMLInputElement;
  const form = input.closest('form')!;
  return { input, submit: () => form.requestSubmit() };
}
