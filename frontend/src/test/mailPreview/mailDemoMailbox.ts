import {
  FakeZimbra,
  zimbraBody,
  type FakeZimbraAnswer,
  type FakeZimbraRequest,
} from '../mailFakes';

/**
 * AN INVENTED SCHOOL MAILBOX, FOR THE DEV-ONLY PREVIEW OF THE MAIL SCREENS (`/dev/mail-preview`).
 *
 * Every name, address and message here is made up; nothing comes from a real mailbox. It answers
 * the SOAP calls the screens make through {@link FakeZimbra} - the same fake the tests use, at the
 * HTTP level - so the preview runs the real session, API and store, with no network.
 */

/** The demo account's address (an invented person on an eligible domain, D1). */
export const DEMO_ADDRESS = 'camille.demo@etu.emse.fr';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface DemoPerson {
  a: string;
  p: string;
}

const ME: DemoPerson = { a: DEMO_ADDRESS, p: 'Camille Demo' };
const BDE: DemoPerson = { a: 'bde@assos.example.test', p: 'BDE' };
const SCOLA: DemoPerson = { a: 'scolarite@example.test', p: 'Scolarité' };
const LEO: DemoPerson = { a: 'leo.fictif@example.test', p: 'Léo Fictif' };
const INES: DemoPerson = { a: 'ines.exemple@example.test', p: 'Inès Exemple' };
const SPORT: DemoPerson = { a: 'sport@assos.example.test', p: 'Bureau des sports' };
const BIB: DemoPerson = { a: 'bibliotheque@example.test', p: 'Bibliothèque' };
const NEWS: DemoPerson = { a: 'newsletter@promo.example.test', p: 'Promo Étudiante' };

interface DemoMessage {
  id: string;
  from: DemoPerson;
  to: DemoPerson[];
  date: number;
  text?: string;
  html?: string;
  unread?: boolean;
  attachments?: { part: string; filename: string; ct: string; s: number; ci?: string }[];
}

interface DemoConversation {
  id: string;
  folder: string;
  subject: string;
  flagged?: boolean;
  messages: DemoMessage[];
}

/*
 * THE COLOURS BELOW ARE A MAIL'S OWN, NOT THE APP'S: they are the content of an invented message,
 * drawn in its sandboxed frame - another document, which the app's tokens (`app.css`) never reach.
 * A real mail carries literal colours like these; the preview shows how the frame draws them.
 */

/** A small invented logo, served as the message's own inline part (`cid:`). */
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" rx="8" fill="#f5b700"/><text x="60" y="26" font-family="sans-serif" font-size="16" text-anchor="middle" fill="#222">BDE</text></svg>';

const GALA_HTML = `<div style="font-family:Georgia,serif;max-width:560px">
<p><img src="cid:logo@bde.example.test" alt="BDE"></p>
<h2 style="color:#7a3b00">Gala d'hiver - les places sont ouvertes</h2>
<p>Bonjour à toutes et à tous,</p>
<p>Le gala d'hiver aura lieu le <b>samedi 13 décembre</b>. Les places sont en vente jusqu'au 5.</p>
<p><img src="https://images.example.test/affiche-gala.jpg" width="520" alt="Affiche du gala"></p>
<p><a href="https://billetterie.example.test/gala">Prendre ma place</a></p>
<p style="color:#888;font-size:12px">Tu reçois ce mail parce que tu es membre du BDE.
<img src="https://track.example.test/open.gif" width="1" height="1" alt=""></p>
</div>`;

const CONVERSATIONS: DemoConversation[] = [
  {
    id: '701',
    folder: '2',
    subject: "Gala d'hiver - les places sont ouvertes",
    messages: [
      {
        id: '7011',
        from: BDE,
        to: [ME],
        date: NOW - 2 * HOUR,
        html: GALA_HTML,
        unread: true,
        attachments: [
          {
            part: '2',
            filename: 'logo.svg',
            ct: 'image/svg+xml',
            s: LOGO_SVG.length,
            ci: '<logo@bde.example.test>',
          },
        ],
      },
    ],
  },
  {
    id: '702',
    folder: '2',
    subject: 'Projet de fin de semestre - répartition des rôles',
    flagged: true,
    messages: [
      {
        id: '7021',
        from: LEO,
        to: [ME, INES],
        date: NOW - 3 * DAY,
        text: "Salut ! Je propose qu'on se répartisse le rapport : je prends l'état de l'art.",
      },
      {
        id: '7022',
        from: INES,
        to: [LEO, ME],
        date: NOW - 3 * DAY + 3 * HOUR,
        text: 'Ok pour moi, je fais la partie expérimentale.',
      },
      {
        id: '7023',
        from: ME,
        to: [LEO, INES],
        date: NOW - 2 * DAY,
        text: "Parfait, je m'occupe des simulations et de la conclusion.",
      },
      {
        id: '7024',
        from: LEO,
        to: [ME, INES],
        date: NOW - 40 * 60 * 1000,
        text: 'Voici le plan mis à jour, avec les échéances.\n\nOn se retrouve jeudi à 14 h à la bibliothèque ?\n\nLéo',
        unread: true,
        attachments: [
          { part: '2', filename: 'plan-projet.pdf', ct: 'application/pdf', s: 184_320 },
        ],
      },
    ],
  },
  {
    id: '703',
    folder: '2',
    subject: 'Inscriptions pédagogiques du second semestre',
    messages: [
      {
        id: '7031',
        from: SCOLA,
        to: [ME],
        date: NOW - DAY - 2 * HOUR,
        text: 'Les inscriptions aux électifs ouvrent lundi à 9 h. Pense à valider tes choix avant vendredi.',
      },
    ],
  },
  {
    id: '704',
    folder: '2',
    subject: 'Tournoi de volley inter-promos',
    messages: [
      {
        id: '7041',
        from: SPORT,
        to: [ME],
        date: NOW - 2 * DAY - 5 * HOUR,
        text: 'Les équipes de six sont à inscrire avant mercredi. Fais tourner !',
        unread: true,
      },
    ],
  },
  {
    id: '705',
    folder: '2',
    subject: 'Rappel : livre à rendre',
    messages: [
      {
        id: '7051',
        from: BIB,
        to: [ME],
        date: NOW - 5 * DAY,
        text: 'Le livre emprunté le 3 est à rendre avant samedi.',
      },
    ],
  },
  {
    id: '706',
    folder: '2',
    subject: 'Soirée jeux de société jeudi',
    messages: [
      {
        id: '7061',
        from: INES,
        to: [ME],
        date: NOW - 9 * DAY,
        text: 'On organise une soirée jeux au foyer, tu viens ?',
      },
    ],
  },
  {
    id: '707',
    folder: '2',
    subject: 'Les offres du mois',
    messages: [
      {
        id: '7071',
        from: NEWS,
        to: [ME],
        date: NOW - 40 * DAY,
        text: 'Découvre les réductions étudiantes de ce mois.',
      },
    ],
  },
  {
    id: '711',
    folder: '5',
    subject: 'Re: Covoiturage pour le week-end',
    messages: [
      {
        id: '7111',
        from: ME,
        to: [LEO],
        date: NOW - 4 * DAY,
        text: 'Je peux prendre deux personnes.',
      },
    ],
  },
  {
    id: '721',
    folder: '412',
    subject: 'Confirmation de ton adhésion',
    messages: [
      { id: '7211', from: BDE, to: [ME], date: NOW - 60 * DAY, text: 'Bienvenue au BDE !' },
    ],
  },
  {
    id: '731',
    folder: '4',
    subject: 'Tu as gagné un voyage !!!',
    messages: [
      {
        id: '7311',
        from: { a: 'promo@spam.example.test', p: 'Super Offre' },
        to: [ME],
        date: NOW - DAY,
        text: 'Clique ici.',
      },
    ],
  },
];

const DIRECTORY: DemoPerson[] = [
  LEO,
  INES,
  { a: 'lea.imaginaire@etu.emse.fr', p: 'Léa Imaginaire' },
  { a: 'lucas.invente@etu.emse.fr', p: 'Lucas Inventé' },
  SCOLA,
];

/** The demo mailbox's state: what each action changes, so the preview behaves. */
export class DemoMailbox {
  private conversations = structuredClone(CONVERSATIONS);
  private archiveExists = true;
  /** When set, every call after sign-in answers this (the error states of the preview). */
  failWith: FakeZimbraAnswer | null = null;
  readonly zimbra = new FakeZimbra((r) => this.answer(r));

  private unreadIn(folder: string): number {
    return this.conversations
      .filter((c) => c.folder === folder)
      .reduce((n, c) => n + c.messages.filter((m) => m.unread).length, 0);
  }

  private countIn(folder: string): number {
    return this.conversations.filter((c) => c.folder === folder).length;
  }

  private folder(id: string, name: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      name,
      view: 'message',
      n: this.countIn(id),
      u: this.unreadIn(id),
      absFolderPath: `/${name}`,
      ...extra,
    };
  }

  private answer(r: FakeZimbraRequest): FakeZimbraAnswer {
    if (!r.soap) return this.download(r);
    const { name, element } = r.soap;
    if (name === 'AuthRequest')
      return zimbraBody({ AuthResponse: { authToken: [{ _content: 'demo' }] } });
    if (name === 'EndSessionRequest') return zimbraBody({ EndSessionResponse: {} });
    if (this.failWith) return this.failWith;
    switch (name) {
      case 'GetInfoRequest':
        return zimbraBody({ GetInfoResponse: { name: DEMO_ADDRESS } });
      case 'GetFolderRequest':
        return zimbraBody({
          GetFolderResponse: {
            folder: [
              {
                id: '1',
                name: 'USER_ROOT',
                folder: [
                  this.folder('2', 'Inbox', { folder: [this.folder('300', 'Clubs')] }),
                  this.folder('5', 'Sent'),
                  this.folder('6', 'Drafts'),
                  this.folder('4', 'Junk'),
                  this.folder('3', 'Trash'),
                  ...(this.archiveExists ? [this.folder('412', 'Archives')] : []),
                  { id: '10', name: 'Calendar', view: 'appointment' },
                ],
              },
            ],
          },
        });
      case 'SearchRequest':
        return this.search(element as { query: string; offset: number; limit: number });
      case 'GetConvRequest':
        return this.conversation((element.c as { id: string }).id);
      case 'ConvActionRequest':
        return this.act(element.action as { op: string; id: string; l?: string });
      case 'CreateFolderRequest':
        this.archiveExists = true;
        return zimbraBody({
          CreateFolderResponse: {
            folder: [{ id: '412', name: 'Archives', l: '1', view: 'message' }],
          },
        });
      case 'AutoCompleteRequest': {
        const typed = String(element.name).toLowerCase();
        const match = DIRECTORY.filter(
          (p) => p.p.toLowerCase().includes(typed) || p.a.includes(typed)
        );
        return zimbraBody({
          AutoCompleteResponse: {
            match: match.map((p) => ({ email: `"${p.p}" <${p.a}>`, type: 'gal' })),
          },
        });
      }
      case 'SendMsgRequest':
        return zimbraBody({ SendMsgResponse: { m: [{ id: '9001' }] } });
      case 'SaveDraftRequest':
        return zimbraBody({ SaveDraftResponse: { m: [{ id: '9002' }] } });
      default:
        return zimbraBody({});
    }
  }

  private summary(c: DemoConversation) {
    const last = c.messages[c.messages.length - 1];
    const unread = c.messages.filter((m) => m.unread).length;
    const flags = `${unread ? 'u' : ''}${c.flagged ? 'f' : ''}${c.messages.some((m) => m.attachments?.some((a) => !a.ci)) ? 'a' : ''}`;
    return {
      id: c.id,
      su: c.subject,
      fr: (last.text ?? "Le gala d'hiver aura lieu le samedi 13 décembre.").slice(0, 120),
      d: last.date,
      n: c.messages.length,
      u: unread,
      f: flags,
      e: [...c.messages].reverse().map((m) => ({ ...m.from, t: 'f' })),
    };
  }

  private search({ query, offset, limit }: { query: string; offset: number; limit: number }) {
    const folder = /inid:"([^"]+)"/.exec(query)?.[1] ?? null;
    let found = this.conversations.filter((c) => folder === null || c.folder === folder);
    if (query.includes('is:flagged')) found = found.filter((c) => c.flagged);
    if (query.includes('is:unread')) found = found.filter((c) => c.messages.some((m) => m.unread));
    if (query.includes('has:attachment'))
      found = found.filter((c) => c.messages.some((m) => m.attachments?.length));
    const words = /\(([^():]*)\)/.exec(query)?.[1]?.trim().toLowerCase();
    if (words && !words.includes(':'))
      found = found.filter((c) => c.subject.toLowerCase().includes(words));
    found.sort(
      (a, b) => b.messages[b.messages.length - 1].date - a.messages[a.messages.length - 1].date
    );
    const page = found.slice(offset, offset + limit);
    return zimbraBody({
      SearchResponse: { c: page.map((c) => this.summary(c)), more: offset + limit < found.length },
    });
  }

  private conversation(id: string): FakeZimbraAnswer {
    const c = this.conversations.find((x) => x.id === id);
    if (!c) return zimbraBody({ GetConvResponse: { c: [] } });
    return zimbraBody({
      GetConvResponse: {
        c: [
          {
            id: c.id,
            su: c.subject,
            m: c.messages.map((m) => ({
              id: m.id,
              cid: c.id,
              l: c.folder,
              su: c.subject,
              fr: (m.text ?? '').slice(0, 120),
              d: m.date,
              f: `${m.unread ? 'u' : ''}${c.flagged ? 'f' : ''}`,
              e: [{ ...m.from, t: 'f' }, ...m.to.map((p) => ({ ...p, t: 't' }))],
              mp: [
                {
                  part: 'TEXT',
                  ct: 'multipart/mixed',
                  mp: [
                    m.html
                      ? { part: '1', ct: 'text/html', body: true, content: m.html }
                      : { part: '1', ct: 'text/plain', body: true, content: m.text ?? '' },
                    ...(m.attachments ?? []).map((a) => ({
                      part: a.part,
                      ct: a.ct,
                      s: a.s,
                      filename: a.filename,
                      cd: a.ci ? 'inline' : 'attachment',
                      ...(a.ci ? { ci: a.ci } : {}),
                    })),
                  ],
                },
              ],
            })),
          },
        ],
      },
    });
  }

  private act(action: { op: string; id: string; l?: string }): FakeZimbraAnswer {
    for (const id of action.id.split(',')) {
      const c = this.conversations.find((x) => x.id === id);
      if (!c) continue;
      if (action.op === 'read') c.messages.forEach((m) => (m.unread = false));
      if (action.op === '!read') c.messages[c.messages.length - 1].unread = true;
      if (action.op === 'flag') c.flagged = true;
      if (action.op === '!flag') c.flagged = false;
      if (action.op === 'move' && action.l) c.folder = action.l;
      if (action.op === 'trash') c.folder = '3';
      if (action.op === 'spam') c.folder = '4';
      if (action.op === 'delete') this.conversations = this.conversations.filter((x) => x !== c);
    }
    return zimbraBody({ ConvActionResponse: { action: { id: action.id, op: action.op } } });
  }

  private download(r: FakeZimbraRequest): FakeZimbraAnswer {
    if (r.path.includes('part=2') && r.path.includes('id=7011')) {
      return { status: 200, body: new TextEncoder().encode(LOGO_SVG) };
    }
    return { status: 200, body: new TextEncoder().encode('%PDF-1.4 demo') };
  }
}
