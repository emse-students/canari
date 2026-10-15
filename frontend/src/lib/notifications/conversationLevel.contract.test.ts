/**
 * The client's half of the shared mention-decision contract
 * (`libs/contracts/mention-decision.cases.json`), also read by Android's `NotificationLevelGateTest`
 * and the iOS `MentionDecisionContractTests` - so the three decisions cannot drift.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  conversationLevelRefusal,
  isConversationNotificationLevel,
  mentionsUser,
} from './conversationLevel';

interface ContractCase {
  name: string;
  level: string | null;
  text: string | null;
  me: string | null;
  expected: 'alert' | 'alert-mention' | 'withhold';
}

const CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'mention-decision.cases.json'),
    'utf8'
  )
) as { me: string; cases: ContractCase[] };

// The client always holds the plaintext and its own id: the undecidable cases are a push's alone.
const clientCases = CONTRACT.cases.filter((c) => c.text !== null && c.me !== null);

describe('conversationLevelRefusal follows the shared mention-decision contract', () => {
  it('reads a contract that has client cases in it', () => {
    expect(clientCases.length).toBeGreaterThan(0);
  });

  it.each(clientCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const level = c.level === null ? 'all' : c.level;
    if (!isConversationNotificationLevel(level)) throw new Error(`bad level in contract: ${level}`);
    const mentionsMe = mentionsUser(c.text!, c.me === 'self' ? CONTRACT.me : c.me!);
    const refusal = conversationLevelRefusal(level, mentionsMe);
    const got = refusal ? 'withhold' : mentionsMe ? 'alert-mention' : 'alert';
    expect(got).toBe(c.expected);
  });
});
