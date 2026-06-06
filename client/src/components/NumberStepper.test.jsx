import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import NumberStepper from './NumberStepper.jsx';

function setup(value = 30) {
  const onChange = vi.fn();
  render(<NumberStepper value={value} onChange={onChange} min={1} max={365} aria-label="Day window" />);
  return { onChange };
}

describe('NumberStepper', () => {
  it('increments and decrements by one', () => {
    const { onChange } = setup(30);
    fireEvent.click(screen.getByRole('button', { name: /increase/i }));
    expect(onChange).toHaveBeenCalledWith(31);
    fireEvent.click(screen.getByRole('button', { name: /decrease/i }));
    expect(onChange).toHaveBeenCalledWith(29);
  });

  it('disables the buttons at the bounds', () => {
    render(<NumberStepper value={1} onChange={() => {}} min={1} max={365} aria-label="d" />);
    expect(screen.getByRole('button', { name: /decrease/i })).toBeDisabled();
    cleanup();
    render(<NumberStepper value={365} onChange={() => {}} min={1} max={365} aria-label="d2" />);
    expect(screen.getByRole('button', { name: /increase/i })).toBeDisabled();
  });

  it('accepts a typed value, clamping above max', () => {
    const { onChange } = setup(30);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '500' } });
    expect(onChange).toHaveBeenLastCalledWith(365);
  });

  it('accepts a typed in-range value as an integer', () => {
    const { onChange } = setup(30);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '12' } });
    expect(onChange).toHaveBeenLastCalledWith(12);
  });

  it('selects the current value on focus for quick replacement', () => {
    setup(30);
    const input = screen.getByRole('spinbutton');
    const selectSpy = vi.spyOn(input, 'select');
    fireEvent.focus(input);
    expect(selectSpy).toHaveBeenCalled();
  });

  it('reverts to the previous value when cleared and blurred', () => {
    const { onChange } = setup(30);
    const input = screen.getByRole('spinbutton');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(30);            // reverted to the committed value
    expect(onChange).not.toHaveBeenCalledWith(0); // clearing never commits a bad value
  });
});
