import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { FormsController } from './forms.controller';
import { contentDisposition } from '../common/content-disposition';

/**
 * A FORM ANSWER'S FILE HAS ONE READER: A MANAGER OF ITS FORM. The download route asks
 * `assertFormManager` before it asks for a single byte, and serves the file with its own type, an
 * `attachment` disposition and `nosniff`.
 */
describe('FormsController - the file download', () => {
  const FILE_ID = '11111111-1111-4111-8111-111111111111';

  function makeController(isManager: boolean) {
    const service: any = {
      assertFormManager: jest.fn(() =>
        isManager ? Promise.resolve({}) : Promise.reject(new ForbiddenException())
      ),
    };
    const formFiles: any = {
      download: jest.fn(() =>
        Promise.resolve({
          data: Buffer.from('%PDF-1.7'),
          contentType: 'application/pdf',
          fileName: 'CV Élise.pdf',
        })
      ),
    };
    const controller = new FormsController(
      service,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      formFiles
    );
    const res: any = { set: jest.fn(), send: jest.fn() };
    return { controller, service, formFiles, res };
  }

  it('refuses a member who does not manage the form, and reads nothing', async () => {
    const { controller, formFiles, res } = makeController(false);
    await expect(controller.downloadAnswerFile('f1', FILE_ID, res, 'stranger')).rejects.toThrow(
      ForbiddenException
    );
    expect(formFiles.download).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('serves a manager the file with its own type and name, as an attachment, nosniff', async () => {
    const { controller, res } = makeController(true);
    await controller.downloadAnswerFile('f1', FILE_ID, res, 'manager');
    const headers = res.set.mock.calls[0][0];
    expect(headers['Content-Type']).toBe('application/pdf');
    expect(headers['Content-Disposition']).toBe(
      `attachment; filename="CV_Elise.pdf"; filename*=UTF-8''CV%20%C3%89lise.pdf`
    );
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });
});

/** An upload is judged by the form's AUDIENCE before a byte is stored, as an answer is at submit. */
describe('FormsController - the file upload', () => {
  const file = { buffer: Buffer.from('%PDF-1.7'), size: 8, originalname: 'cv.pdf' } as any;

  function makeController(mayAnswer: boolean) {
    const service: any = {
      assertMayUploadAnswerFile: jest.fn(() =>
        mayAnswer
          ? Promise.resolve()
          : Promise.reject(new ForbiddenException('This form is not open to you.'))
      ),
    };
    const formFiles: any = { upload: jest.fn(() => Promise.resolve({ fileId: 'x' })) };
    const controller = new FormsController(
      service,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      formFiles
    );
    return { controller, service, formFiles };
  }

  it('refuses a member outside the form audience, and stores nothing', async () => {
    const { controller, formFiles } = makeController(false);
    await expect(controller.uploadAnswerFile('f1', file, 'q_cv', 'outsider')).rejects.toThrow(
      'not open to you'
    );
    expect(formFiles.upload).not.toHaveBeenCalled();
  });

  it('hands an eligible member file to the upload', async () => {
    const { controller, service, formFiles } = makeController(true);
    await controller.uploadAnswerFile('f1', file, 'q_cv', 'member');
    expect(service.assertMayUploadAnswerFile).toHaveBeenCalledWith('f1', 'member');
    expect(formFiles.upload).toHaveBeenCalledWith('f1', 'q_cv', file, 'member');
  });
});

describe('contentDisposition', () => {
  it('keeps the export header it replaced', () => {
    expect(contentDisposition("Gala d'hiver.xlsx", 'export')).toBe(
      `attachment; filename="Gala_dhiver.xlsx"; filename*=UTF-8''Gala%20d%27hiver.xlsx`
    );
  });

  it('falls back to the given ASCII stem when nothing ASCII is left', () => {
    expect(contentDisposition('简历.pdf', 'a1b2c3d4')).toMatch(
      /^attachment; filename="a1b2c3d4.pdf"/
    );
  });
});
