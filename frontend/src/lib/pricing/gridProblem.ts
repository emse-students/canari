import { m } from '$lib/paraglide/messages';
import type { GridProblem } from './priceMatrix';

/**
 * What a manager is told about a grid that cannot be saved.
 *
 * One mapping for the two places that need it: the sentence under the grid, and the error the save
 * button raises. They were about to be two copies of the same six-branch ternary, which is how the
 * editor ends up naming a problem the save does not block - or blocking one it never named.
 */
export function gridProblemMessage(problem: GridProblem): string {
  switch (problem) {
    case 'no_criterion':
      return m.form_grid_problem_no_criterion();
    case 'empty_criterion':
      return m.form_grid_problem_empty_criterion();
    case 'unnamed_group':
      return m.form_grid_problem_unnamed_group();
    case 'no_question':
      return m.form_grid_problem_no_question();
    case 'empty_group':
      return m.form_grid_problem_empty_group();
    case 'all_unavailable':
      return m.form_grid_problem_all_unavailable();
    case 'incomplete':
      return m.form_grid_problem_incomplete();
  }
}
