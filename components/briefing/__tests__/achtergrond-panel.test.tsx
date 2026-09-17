import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AchtergrondPanel } from '../achtergrond-panel';

afterEach(cleanup);

const vak = () =>
  screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Achtergrondinformatie' });

describe('AchtergrondPanel', () => {
  it('begint met de tekst van de Opportunity', () => {
    render(<AchtergrondPanel bron="Van de Opportunity." eigen={null} onChange={vi.fn()} />);
    expect(vak().value).toBe('Van de Opportunity.');
  });

  it('slaat getypte tekst op, en niets zolang hij gelijk is aan de Opportunity', () => {
    const onChange = vi.fn();
    render(<AchtergrondPanel bron="Van de Opportunity." eigen={null} onChange={onChange} />);
    fireEvent.change(vak(), { target: { value: 'Eigen tekst.' } });
    expect(onChange).toHaveBeenLastCalledWith('Eigen tekst.');
    fireEvent.change(vak(), { target: { value: 'Van de Opportunity.' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('zet de Opportunity-tekst terug met Herstel', () => {
    const onChange = vi.fn();
    render(<AchtergrondPanel bron="Van de Opportunity." eigen="Eigen." onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Herstel de Opportunity-tekst' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(vak().value).toBe('Van de Opportunity.');
  });

  it('zegt het als de Opportunity leeg is', () => {
    render(<AchtergrondPanel bron="" eigen={null} onChange={vi.fn()} />);
    expect(screen.getByText(/nog niets op de Opportunity/)).toBeTruthy();
  });
});
