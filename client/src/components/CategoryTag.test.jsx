import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CategoryTag, { TopicSource } from './CategoryTag.jsx';
import { categoryLabels } from '../lib/categoryAbbr.js';

// #196: a category's short label wherever space is tight, its full name on hover.
describe('CategoryTag and TopicSource', () => {
  const labels = categoryLabels(['AP CS: Computational Thinking Practices']);

  it('shows the short label, named and popped up as the full name', () => {
    render(<CategoryTag label={labels.get('AP CS: Computational Thinking Practices')} />);
    const tag = screen.getByRole('img', { name: 'Computational Thinking Practices' });
    expect(tag).toHaveTextContent('CTP');
    fireEvent.mouseEnter(tag);
    expect(document.querySelector('.help-pop')).toHaveTextContent('Computational Thinking Practices');
  });

  it('the line under a topic: the short label and the topic number', () => {
    const { container } = render(<TopicSource topic={{ category_title: 'AP CS: Computational Thinking Practices', external_id: 'APCS.2.3' }} labels={labels} />);
    expect(container).toHaveTextContent(/^CTP 2\.3$/);
  });

  it('a topic with no category shows its number alone; no number, the label alone', () => {
    const { container, rerender } = render(<TopicSource topic={{ category_title: null, external_id: 'X9' }} labels={labels} />);
    expect(container).toHaveTextContent(/^X9$/);
    rerender(<TopicSource topic={{ category_title: 'AP CS: Computational Thinking Practices', external_id: '' }} labels={labels} />);
    expect(container).toHaveTextContent(/^CTP$/);
  });
});
