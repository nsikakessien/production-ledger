import { describe, expect, it } from 'vitest';
import { allocate } from '../../src/allocation';

const insts = [
  { number: 1, dueDate: '2025-02-15', interest: 1_800_000n, principal: 19_263_026n },
  { number: 2, dueDate: '2025-03-15', interest: 1_511_055n, principal: 19_551_971n },
];

describe('allocation waterfall', () => {
  it('applies penalty, fee, interest, principal on the oldest due instalment first', () => {
    const charges = [
      { instalmentNumber: 1, type: 'FEE' as const, amount: 300n, assessedOn: '2025-02-16' },
      { instalmentNumber: 1, type: 'PENALTY' as const, amount: 500n, assessedOn: '2025-02-16' },
    ];
    const r = allocate(insts, charges, [{ id: '1', amount: 1_000n, valueDate: '2025-02-20' }]);
    expect(r.get('1')).toEqual([
      { instalmentNumber: 1, component: 'PENALTY', amount: 500n },
      { instalmentNumber: 1, component: 'FEE', amount: 300n },
      { instalmentNumber: 1, component: 'INTEREST', amount: 200n },
    ]);
  });

  it('never pre-pays instalments that are not yet due: the excess is unapplied credit', () => {
    const r = allocate(insts, [], [{ id: '1', amount: 30_000_000n, valueDate: '2025-02-15' }]);
    expect(r.get('1')).toEqual([
      { instalmentNumber: 1, component: 'INTEREST', amount: 1_800_000n },
      { instalmentNumber: 1, component: 'PRINCIPAL', amount: 19_263_026n },
      { instalmentNumber: null, component: 'UNAPPLIED', amount: 30_000_000n - 21_063_026n },
    ]);
  });

  it('a payment before any due date is entirely unapplied', () => {
    const r = allocate(insts, [], [{ id: '1', amount: 5n, valueDate: '2025-02-14' }]);
    expect(r.get('1')).toEqual([{ instalmentNumber: null, component: 'UNAPPLIED', amount: 5n }]);
  });

  it('orders by value date then sequence, regardless of delivery order', () => {
    const late = { id: '1', amount: 21_063_026n, valueDate: '2025-03-15' };
    const early = { id: '2', amount: 21_063_026n, valueDate: '2025-02-15' };
    const r = allocate(insts, [], [late, early]);
    expect(r.get('2')!.map((l) => l.instalmentNumber)).toEqual([1, 1]);
    expect(r.get('1')!.map((l) => l.instalmentNumber)).toEqual([2, 2]);
  });

  it('spreads a payment across several due instalments', () => {
    const r = allocate(insts, [], [{ id: '1', amount: 22_000_000n, valueDate: '2025-03-20' }]);
    expect(r.get('1')).toEqual([
      { instalmentNumber: 1, component: 'INTEREST', amount: 1_800_000n },
      { instalmentNumber: 1, component: 'PRINCIPAL', amount: 19_263_026n },
      { instalmentNumber: 2, component: 'INTEREST', amount: 936_974n },
    ]);
  });

  it('charges assessed after a payment date do not affect that payment', () => {
    const charges = [{ instalmentNumber: 1, type: 'PENALTY' as const, amount: 500n, assessedOn: '2025-03-01' }];
    const r = allocate(insts, charges, [
      { id: '1', amount: 100n, valueDate: '2025-02-20' },
      { id: '2', amount: 600n, valueDate: '2025-03-02' },
    ]);
    expect(r.get('1')).toEqual([{ instalmentNumber: 1, component: 'INTEREST', amount: 100n }]);
    expect(r.get('2')![0]).toEqual({ instalmentNumber: 1, component: 'PENALTY', amount: 500n });
  });
});
