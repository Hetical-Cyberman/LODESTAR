import type { NewRequestInput } from "@/lib/types";

export const GUARDIAN_RULES = {
  amountCap: 5,
  burstLimit: 3,
  burstWindowSeconds: 60,
  anomalyZScore: 3.5,
  allowlist: ["vendor.testnet", "friend.testnet"],
};

export type Evaluation = {
  held: boolean;
  reasons: string[];
  anomalyScore: number;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function robustZScore(value: number, baseline: number[]): number {
  if (baseline.length < 4) return 0;
  const center = median(baseline);
  const deviation = median(baseline.map((item) => Math.abs(item - center)));
  if (deviation === 0) return value === center ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs((0.6745 * (value - center)) / deviation);
}

export function evaluateRequest(
  input: NewRequestInput,
  context: { sentCountInWindow: number; historyAmounts: number[]; knownRecipients: string[]; allowlist?: string[] },
): Evaluation {
  const reasons: string[] = [];

  if (input.kind === "add_key" || input.kind === "delete_key") {
    reasons.push("A wallet access key is changing. Review the key before allowing account access to change.");
    return { held: true, reasons, anomalyScore: 0 };
  }

  const amount = Number(input.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    reasons.push("The transfer amount is invalid.");
  } else if (amount > GUARDIAN_RULES.amountCap) {
    reasons.push(`The transfer is ${amount} NEAR, above your ${GUARDIAN_RULES.amountCap} NEAR limit.`);
  }

  const recipientIsKnown =
    (context.allowlist ?? GUARDIAN_RULES.allowlist).includes(input.recipient) || context.knownRecipients.includes(input.recipient);
  if (!recipientIsKnown) {
    reasons.push("This wallet has not sent funds to this recipient before.");
  }

  const nextCount = context.sentCountInWindow + 1;
  if (nextCount > GUARDIAN_RULES.burstLimit) {
    reasons.push(
      `${nextCount} transfer requests fall within ${GUARDIAN_RULES.burstWindowSeconds} seconds; your limit is ${GUARDIAN_RULES.burstLimit}.`,
    );
  }

  const anomalyScore = robustZScore(amount, context.historyAmounts);
  if (anomalyScore > GUARDIAN_RULES.anomalyZScore) {
    reasons.push(`The amount is unusual for this wallet (anomaly score ${anomalyScore.toFixed(1)}).`);
  }

  return { held: reasons.length > 0, reasons, anomalyScore };
}
