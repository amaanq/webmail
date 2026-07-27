import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Regression coverage for cross-account destination resolution: when the
// owning account's mailbox list is not cached, delete/move actions used to
// fall back to the ACTIVE account's list and send its mailbox ids (e.g. a
// Stalwart trash id like "b") to a backend that has never heard of them. The
// server rightly refuses, so the email never moves. Destination-resolving
// actions must fetch the owning account's list instead of borrowing one.

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    isSubscribed: true,
    isShared: false,
    ...overrides,
  };
}

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'email-1',
    threadId: 'thread-1',
    subject: 'Hi',
    receivedAt: new Date().toISOString(),
    keywords: {},
    mailboxIds: { 'jm-inbox': true },
    sourceClientAccountId: 'account-b',
    sourceAccountId: 'jmap-b',
    ...overrides,
  } as Email;
}

const ownedMailboxes = [
  makeMailbox({ id: 'jm-inbox', role: 'inbox', accountId: 'jmap-b' }),
  makeMailbox({ id: 'jm-trash', name: 'Trash', role: 'trash', accountId: 'jmap-b' }),
];

function makeClient(accountId: string, mailboxes: Mailbox[] = []) {
  return {
    getAccountId: vi.fn().mockReturnValue(accountId),
    getMailboxes: vi.fn().mockResolvedValue(mailboxes),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    moveToTrash: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
  } as unknown as IJMAPClient;
}

describe('destination resolution for foreign-owned emails', () => {
  let activeClient: IJMAPClient;
  let owningClient: IJMAPClient;

  beforeEach(() => {
    // The active login is a different backend whose trash has a compact id
    // ("b") that means nothing to the email's owning account.
    activeClient = makeClient('stalwart-a', [
      makeMailbox({ id: 'a-inbox', role: 'inbox', accountId: 'stalwart-a' }),
      makeMailbox({ id: 'b', name: 'Trash', role: 'trash', accountId: 'stalwart-a' }),
    ]);
    owningClient = makeClient('jmap-b', ownedMailboxes);

    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) =>
        (id === 'account-b' ? owningClient : id === 'account-a' ? activeClient : undefined) as never,
    } as never);

    useSettingsStore.setState({
      deleteAction: 'trash',
      permanentlyDeleteJunk: false,
    } as never);

    useEmailStore.setState({
      isUnifiedView: false,
      viewingAccountId: null,
      selectedMailbox: 'a-inbox',
      emails: [makeEmail()],
      mailboxes: [
        makeMailbox({ id: 'a-inbox', role: 'inbox', accountId: 'stalwart-a' }),
        makeMailbox({ id: 'b', name: 'Trash', role: 'trash', accountId: 'stalwart-a' }),
      ],
      // The owning account's list is deliberately NOT cached.
      accountMailboxes: {},
      selectedEmail: null,
      selectedEmailIds: new Set(),
      error: null,
    });
  });

  it('deleteEmail fetches the owning account list and uses ITS trash id', async () => {
    await useEmailStore.getState().deleteEmail(activeClient, 'email-1');

    expect(owningClient.getMailboxes).toHaveBeenCalled();
    expect(owningClient.moveToTrash).toHaveBeenCalledWith('email-1', 'jm-trash', 'jmap-b', false);
    expect(activeClient.moveToTrash).not.toHaveBeenCalled();
  });

  it('moveToMailbox refuses a destination id from another account', async () => {
    await expect(
      useEmailStore.getState().moveToMailbox(activeClient, 'email-1', 'b'),
    ).rejects.toThrow(/does not belong/);

    expect(owningClient.moveEmail).not.toHaveBeenCalled();
    expect(activeClient.moveEmail).not.toHaveBeenCalled();
  });

  it('moveToMailbox moves through the owning account when the id is its own', async () => {
    await useEmailStore.getState().moveToMailbox(activeClient, 'email-1', 'jm-trash');

    expect(owningClient.moveEmail).toHaveBeenCalledWith('email-1', 'jm-trash', 'jmap-b');
  });

  it('does not fill the owning cache through a client that cannot reach it', async () => {
    useEmailStore.setState({ emails: [makeEmail({ sourceClientAccountId: 'logged-out' })] });

    await expect(
      useEmailStore.getState().deleteEmail(activeClient, 'email-1'),
    ).rejects.toThrow(/Trash mailbox not found/);

    // Fetching through the active login would cache ITS folders under the
    // owning account's key, which is how the wrong trash id got sent.
    expect(activeClient.getMailboxes).not.toHaveBeenCalled();
    expect(useEmailStore.getState().accountMailboxes['jmap-b']).toBeUndefined();
    expect(activeClient.moveToTrash).not.toHaveBeenCalled();
  });
});

// The selected folder is an id of the VIEW's mailbox list. Mailbox ids are
// only unique per account and compact ids repeat across them, so resolving the
// selection inside another account's list can match an unrelated folder - and
// when that folder happened to be a trash or junk, a first delete escalated to
// an irreversible permanent delete.
describe('view state resolves in the view id space', () => {
  let activeClient: IJMAPClient;
  let owningClient: IJMAPClient;

  const collidingOwnedMailboxes = [
    makeMailbox({ id: 'jm-inbox', role: 'inbox', accountId: 'jmap-b' }),
    makeMailbox({ id: 'b', name: 'Junk', role: 'junk', accountId: 'jmap-b' }),
    makeMailbox({ id: 'jm-trash', name: 'Trash', role: 'trash', accountId: 'jmap-b' }),
  ];

  beforeEach(() => {
    activeClient = makeClient('stalwart-a');
    owningClient = makeClient('jmap-b', collidingOwnedMailboxes);

    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) =>
        (id === 'account-b' ? owningClient : id === 'account-a' ? activeClient : undefined) as never,
    } as never);

    useSettingsStore.setState({
      deleteAction: 'trash',
      permanentlyDeleteJunk: true,
    } as never);

    useEmailStore.setState({
      isUnifiedView: false,
      viewingAccountId: null,
      // "b" is the open INBOX here, but names the owning account's Junk.
      selectedMailbox: 'b',
      emails: [makeEmail()],
      mailboxes: [makeMailbox({ id: 'b', name: 'Inbox', role: 'inbox', accountId: 'stalwart-a' })],
      accountMailboxes: { 'jmap-b': collidingOwnedMailboxes },
      selectedEmail: null,
      selectedEmailIds: new Set(),
      error: null,
    });
  });

  it('does not escalate to a permanent delete on a colliding folder id', async () => {
    await useEmailStore.getState().deleteEmail(activeClient, 'email-1');

    expect(owningClient.moveToTrash).toHaveBeenCalledWith('email-1', 'jm-trash', 'jmap-b', false);
    expect(owningClient.deleteEmail).not.toHaveBeenCalled();
  });

  it('still auto-destroys junk when the email really is in its account junk', async () => {
    useEmailStore.setState({
      selectedMailbox: 'junk-view',
      mailboxes: [makeMailbox({ id: 'junk-view', name: 'Junk', role: 'junk', accountId: 'stalwart-a' })],
      emails: [makeEmail({ mailboxIds: { b: true } })],
    });

    await useEmailStore.getState().deleteEmail(activeClient, 'email-1');

    expect(owningClient.deleteEmail).toHaveBeenCalledWith('email-1');
    expect(owningClient.moveToTrash).not.toHaveBeenCalled();
  });
});
