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

  describe('step and suffix', () => {
    const stepped = (value, props = {}) => {
      const onChange = vi.fn();
      render(<NumberStepper value={value} onChange={onChange} min={0} max={100} step={5} aria-label="Minutes" {...props} />);
      return { onChange };
    };

    it('step 5 moves 50 to 55 and 45', () => {
      const { onChange } = stepped(50);
      fireEvent.click(screen.getByRole('button', { name: /increase/i }));
      expect(onChange).toHaveBeenLastCalledWith(55);
      fireEvent.click(screen.getByRole('button', { name: /decrease/i }));
      expect(onChange).toHaveBeenLastCalledWith(45);
    });

    it('a typed 52 with step 5 becomes 50', () => {
      const { onChange } = stepped(30);
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '52' } });
      expect(onChange).toHaveBeenLastCalledWith(50);
    });

    it('a typed 53 with step 5 becomes 55, and the result is clamped', () => {
      const { onChange } = stepped(30);
      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '53' } });
      expect(onChange).toHaveBeenLastCalledWith(55);
      fireEvent.change(input, { target: { value: '99' } });
      expect(onChange).toHaveBeenLastCalledWith(100);
    });

    it('the buttons stop at the bounds', () => {
      const { onChange } = stepped(98);
      fireEvent.click(screen.getByRole('button', { name: /increase/i }));
      expect(onChange).toHaveBeenLastCalledWith(100);
    });

    it('the default step 1 behaves as before', () => {
      const { onChange } = setup(30);
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '37' } });
      expect(onChange).toHaveBeenLastCalledWith(37);
      fireEvent.click(screen.getByRole('button', { name: /increase/i }));
      expect(onChange).toHaveBeenLastCalledWith(31);
    });

    it('shows the suffix after the value, outside the typed value', () => {
      stepped(50, { suffix: 'min' });
      expect(screen.getByText('min')).toBeInTheDocument();
      expect(screen.getByRole('spinbutton')).toHaveValue(50);
      expect(screen.getByRole('spinbutton')).toHaveAccessibleName('Minutes');
    });

    it('passes step to the input so the keyboard arrows move by it', () => {
      stepped(50);
      expect(screen.getByRole('spinbutton')).toHaveAttribute('step', '5');
    });

    it('shows no suffix by default', () => {
      const { container } = render(<NumberStepper value={3} onChange={() => {}} aria-label="n" />);
      expect(container.querySelector('.number-stepper__suffix')).toBeNull();
    });
  });
});
