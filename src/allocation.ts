import { minBig } from "./money";

export const COMPONENTS = ["PENALTY", "FEE", "INTEREST", "PRINCIPAL"] as const;
export type DueComponent = (typeof COMPONENTS)[number];
export type Component = DueComponent | "UNAPPLIED";

export interface AllocInstalment {
  number: number;
  dueDate: string;
  interest: bigint;
  principal: bigint;
}

export interface AllocCharge {
  instalmentNumber: number;
  type: "PENALTY" | "FEE";
  amount: bigint;
  assessedOn: string;
}

export interface AllocPayment {
  id: string;
  amount: bigint;
  valueDate: string;
}

export interface AllocLine {
  instalmentNumber: number | null;
  component: Component;
  amount: bigint;
}

export const bucketKey = (
  instalmentNumber: number | null,
  component: Component,
) => `${instalmentNumber ?? "-"}:${component}`;

export function comparePayments(a: AllocPayment, b: AllocPayment): number {
  if (a.valueDate !== b.valueDate) return a.valueDate < b.valueDate ? -1 : 1;
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function allocate(
  instalments: AllocInstalment[],
  charges: AllocCharge[],
  payments: AllocPayment[],
): Map<string, AllocLine[]> {
  const insts = [...instalments].sort((a, b) => a.number - b.number);
  const ordered = [...payments].sort(comparePayments);
  const collected = new Map<string, bigint>(); // bucketKey -> collected so far
  const result = new Map<string, AllocLine[]>();

  const owedAsOf = (
    inst: AllocInstalment,
    comp: DueComponent,
    asOf: string,
  ): bigint => {
    switch (comp) {
      case "INTEREST":
        return inst.interest;
      case "PRINCIPAL":
        return inst.principal;
      default:
        return charges
          .filter(
            (c) =>
              c.instalmentNumber === inst.number &&
              c.type === comp &&
              c.assessedOn <= asOf,
          )
          .reduce((s, c) => s + c.amount, 0n);
    }
  };

  for (const p of ordered) {
    let remaining = p.amount;
    const lines: AllocLine[] = [];
    for (const inst of insts) {
      if (remaining === 0n) break;
      if (inst.dueDate > p.valueDate) break;
      for (const comp of COMPONENTS) {
        if (remaining === 0n) break;
        const key = bucketKey(inst.number, comp);
        const outstanding =
          owedAsOf(inst, comp, p.valueDate) - (collected.get(key) ?? 0n);
        if (outstanding <= 0n) continue;
        const take = minBig(outstanding, remaining);
        collected.set(key, (collected.get(key) ?? 0n) + take);
        lines.push({
          instalmentNumber: inst.number,
          component: comp,
          amount: take,
        });
        remaining -= take;
      }
    }
    if (remaining > 0n)
      lines.push({
        instalmentNumber: null,
        component: "UNAPPLIED",
        amount: remaining,
      });
    result.set(p.id, lines);
  }
  return result;
}

/** Account credited for each allocation component when a payment is received. */
export const COMPONENT_ACCOUNT: Record<Component, string> = {
  PENALTY: "PENALTY_INCOME",
  FEE: "FEE_INCOME",
  INTEREST: "INTEREST_RECEIVABLE",
  PRINCIPAL: "LOANS_RECEIVABLE",
  UNAPPLIED: "UNAPPLIED_CREDIT",
};
