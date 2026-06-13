import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SchoologyLink from './SchoologyLink.jsx';

describe('SchoologyLink', () => {
  it('links to the url and opens safely in a new tab', () => {
    render(<SchoologyLink url="https://hkis.schoology.com/assignment/1/info" label="View in Schoology" />);
    const link = screen.getByRole('link', { name: /view in schoology/i });
    expect(link).toHaveAttribute('href', 'https://hkis.schoology.com/assignment/1/info');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the external-link glyph', () => {
    render(<SchoologyLink url="https://x" label="View in Schoology" />);
    expect(screen.getByRole('link').querySelector('svg')).toBeTruthy();
  });

  it('renders nothing when no url is available', () => {
    const { container } = render(<SchoologyLink url={null} label="View in Schoology" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is icon-only (no visible label) with a custom accessible name via ariaLabel', () => {
    render(<SchoologyLink url="https://x" ariaLabel='View "Project" in Schoology' />);
    const link = screen.getByRole('link', { name: 'View "Project" in Schoology' });
    expect(link).toHaveTextContent('');
  });
});
