import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { FormsController } from './forms.controller';

/**
 * THE RESULTS SUMMARY HAS THE RESPONSES LIST'S READER: A MANAGER OF THE FORM (G-RESULTS). The route
 * asks `assertFormManager` first, as `getSubmissions` does, so a member who answered the form - or a
 * stranger - reads no aggregate: a count of an anonymous form's few answers is those answers.
 */
describe('FormsController - the results summary', () => {
  function makeController(isManager: boolean) {
    const service: any = {
      assertFormManager: jest.fn(() =>
        isManager ? Promise.resolve({}) : Promise.reject(new ForbiddenException())
      ),
      getResults: jest.fn(() => Promise.resolve({ totalAnswers: 3, questions: [] })),
    };
    const controller = new FormsController(
      service,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { controller, service };
  }

  it('refuses a member who does not manage the form, and aggregates nothing', async () => {
    const { controller, service } = makeController(false);
    await expect(controller.getResults('f1', 'stranger')).rejects.toThrow(ForbiddenException);
    expect(service.getResults).not.toHaveBeenCalled();
  });

  it('serves a manager, a global admin included, the aggregates', async () => {
    const { controller, service } = makeController(true);
    await expect(controller.getResults('f1', 'm1', 'true')).resolves.toEqual({
      totalAnswers: 3,
      questions: [],
    });
    expect(service.assertFormManager).toHaveBeenCalledWith('f1', 'm1', true);
  });
});

/** The respondents route has the SAME reader as the answers it is drawn from. */
describe('FormsController - the respondents of a form', () => {
  it('refuses a member who does not manage the form, and reads no respondent', async () => {
    const service: any = {
      assertFormManager: jest.fn(() => Promise.reject(new ForbiddenException())),
      respondentsForGroup: jest.fn(),
    };
    const controller = new FormsController(
      service,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    await expect(controller.getRespondents('f1', 'stranger')).rejects.toThrow(ForbiddenException);
    expect(service.respondentsForGroup).not.toHaveBeenCalled();
  });
});
