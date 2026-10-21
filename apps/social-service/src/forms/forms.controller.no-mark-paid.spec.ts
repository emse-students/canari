import 'reflect-metadata';

import { FormsController } from './forms.controller';

/**
 * THE PUBLIC `mark-paid` MUST STAY DELETED.
 *
 * Until 2026-08-22 the submitter could POST their own pending submission to `mark-paid` and receive
 * a paid status, the form's cotisation tag and a purchase record, with no payment behind any of it
 * (the story is in `CHANGELOG.md`, the comment above `confirmPayment` in the controller names the
 * three legitimate ways a submission becomes paid). Nothing in the repository would have failed if
 * it came back, so this reads the route table Nest itself reads: a path or a handler that names
 * `mark-paid` on THIS controller is the regression. The internal route lives on
 * `InternalFormsController`, behind the shared secret, and is not this controller's.
 */
describe('FormsController - no public mark-paid', () => {
  const PATH_METADATA = 'path';
  const proto = FormsController.prototype as unknown as Record<string, unknown>;
  const handlers = Object.getOwnPropertyNames(FormsController.prototype).filter(
    (name) => name !== 'constructor'
  );

  it('has handlers to read at all', () => {
    // An empty prototype would make the assertions below vacuously true.
    expect(handlers.length).toBeGreaterThan(5);
  });

  it('exposes no route whose path names mark-paid', () => {
    const paths = handlers.map((h) =>
      String(Reflect.getMetadata(PATH_METADATA, proto[h] as object))
    );
    expect(paths.filter((p) => /mark-?paid/i.test(p))).toEqual([]);
  });

  it('has no handler named after it either', () => {
    expect(handlers.filter((h) => /mark-?paid/i.test(h))).toEqual([]);
  });
});
