import { truncateLogIds } from './logTruncate';

describe('truncateLogIds', () => {
  it('tronque un UUID à 8 caractères + …', () => {
    expect(truncateLogIds('group=67fde7aa-94b5-4529-8798-883ef0faad42')).toBe('group=67fde7aa…');
  });

  it('tronque un userId 64-hex', () => {
    const id = 'd82cd2268993451edb547bdd7ff278447f6619f67d0d73a520897e54f0714df2';
    expect(truncateLogIds(`user=${id}`)).toBe('user=d82cd226…');
  });

  it('tronque la partie hex embarquée dans un device id composite', () => {
    const id = 'web-d82cd2268993451edb547bdd7ff278447f6619f67d0d73a520897e54f0714df2-mq8acpb6-u4dt';
    expect(truncateLogIds(id)).toBe('web-d82cd226…-mq8acpb6-u4dt');
  });

  it('laisse intacts les hex courts (epochs, couleurs)', () => {
    expect(truncateLogIds('epoch=42 color=#151B2C n=1af3')).toBe('epoch=42 color=#151B2C n=1af3');
  });

  it('tronque plusieurs identifiants dans la même ligne', () => {
    expect(
      truncateLogIds('group=67fde7aa-94b5-4529-8798-883ef0faad42 sender=ab12cd34ef56ab78')
    ).toBe('group=67fde7aa… sender=ab12cd34…');
  });
});
