import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HelpDot from './HelpDot.jsx';

const TEXT = 'Late counts school days from the due date.';
const pop = (container) => container.querySelector('.help-pop');

describe('HelpDot', () => {
  const width = window.innerWidth;
  afterEach(() => { window.innerWidth = width; });

  it('shows the popover on hover and hides it on leave (desktop)', () => {
    const { container } = render(<HelpDot text={TEXT} />);
    const dot = screen.getByRole('img', { name: TEXT });
    fireEvent.mouseEnter(dot);
    expect(pop(container)).toHaveTextContent(TEXT);
    fireEvent.mouseLeave(dot);
    expect(pop(container)).toBeNull();
  });

  // A phone has no hover (#134): a tap shows it, tapping elsewhere (blur) or
  // scrolling hides it.
  it('a tap shows the popover; a blur hides it', () => {
    const { container } = render(<HelpDot text={TEXT} />);
    const dot = screen.getByRole('img', { name: TEXT });
    fireEvent.click(dot);
    expect(pop(container)).toHaveTextContent(TEXT);
    fireEvent.blur(dot);
    expect(pop(container)).toBeNull();
  });

  it('a tap on a shown popover keeps it shown (a click after hover does not hide it)', () => {
    const { container } = render(<HelpDot text={TEXT} />);
    const dot = screen.getByRole('img', { name: TEXT });
    fireEvent.mouseEnter(dot);
    fireEvent.click(dot);
    expect(pop(container)).not.toBeNull();
  });

  it('scrolling hides the popover, since it is fixed and the dot moves', () => {
    const { container } = render(<HelpDot text={TEXT} />);
    fireEvent.click(screen.getByRole('img', { name: TEXT }));
    expect(pop(container)).not.toBeNull();
    fireEvent.scroll(window);
    expect(pop(container)).toBeNull();
  });

  it('keeps the popover on screen when the dot is near the edge of a narrow screen', () => {
    window.innerWidth = 390;
    const { container } = render(<HelpDot text={TEXT} />);
    const dot = screen.getByRole('img', { name: TEXT });
    dot.getBoundingClientRect = () => ({ left: 370, right: 386, top: 10, bottom: 26, width: 16, height: 16 });
    fireEvent.click(dot);
    expect(pop(container).style.left).toBe(`${390 - 138}px`);
    dot.getBoundingClientRect = () => ({ left: 4, right: 20, top: 10, bottom: 26, width: 16, height: 16 });
    fireEvent.click(dot);
    expect(pop(container).style.left).toBe('138px');
  });
});

describe('HelpDot with children', () => {
  it('shows the children in the popover; the text stays the aria-label', () => {
    const { container } = render(<HelpDot text="Plain words"><ul><li>One</li></ul></HelpDot>);
    const dot = screen.getByRole('img', { name: 'Plain words' });
    fireEvent.click(dot);
    expect(container.querySelector('.help-pop li')).toHaveTextContent('One');
    expect(container.querySelector('.help-pop')).not.toHaveTextContent('Plain words');
  });
});
