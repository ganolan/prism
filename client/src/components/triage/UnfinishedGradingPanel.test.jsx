import { describe, it, expect } from 'vitest';
import { unfinishedGradingText } from './UnfinishedGradingPanel.jsx';

describe('unfinishedGradingText', () => {
  it('names each reason with its count', () => {
    expect(unfinishedGradingText({ drafts: 2, feedbackHidden: 1, unreadComments: 1 }))
      .toBe('2 drafts not published, 1 with comment hidden, 1 unread comment');
  });

  it('an unpublished task says why the feedback is hidden (#184)', () => {
    expect(unfinishedGradingText({ drafts: 0, feedbackHidden: 3, unreadComments: 0, taskUnpublished: true }))
      .toBe('3 with feedback hidden (task not published)');
  });
});
